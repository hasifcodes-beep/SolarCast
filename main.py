from datetime import datetime, timedelta, timezone
import logging

import httpx
import joblib
import numpy as np
import polars as pl
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

# uvicorn main:app --reload

logging.basicConfig(level=logging.INFO)
log = logging.getLogger("solar")

# ── Load learned model once at startup ─────────────────────────────
MODEL_PATH = "solar_model.pkl"
ARTIFACT = None
try:
    ARTIFACT = joblib.load(MODEL_PATH)
    log.info("Loaded %s (classes=%s, floor=%.3f, good=%.3f)",
             MODEL_PATH, ARTIFACT.get("classes"),
             ARTIFACT.get("floor"), ARTIFACT.get("good"))
except Exception as e:
    log.warning("Could not load %s: %s — using fallback heuristic.", MODEL_PATH, e)

# Fallback constants (only used if solar_model.pkl is absent)
FALLBACK_FLOOR, FALLBACK_GOOD = 0.34, 0.61
CANONICAL = ["GOOD", "MARGINAL", "NO"]

# Decision horizon: how many hours after "now" the agent may wait for a better hour.
LOOKAHEAD_HOURS = 24

app = FastAPI(title="Solar Utility Agent")
app.add_middleware(CORSMiddleware, allow_origins=["*"],
                   allow_methods=["*"], allow_headers=["*"])
app.mount("/static", StaticFiles(directory="static"), name="static")


class Req(BaseModel):
    latitude: float
    longitude: float
    forecast_days: int = 7
    mock_now: str | None = None  # Optional simulated "now" (local time at the location)


def _fallback_proba(ghi, rain):
    """Crude pseudo-probabilities, only if solar_model.pkl is missing."""
    base = np.clip(ghi / 1000.0, 0, 1) * (1 - 0.2 * rain / 100.0)
    p_good = np.clip(base, 0, 1)
    p_marg = np.clip(1 - np.abs(base - 0.5) * 2, 0, 1) * 0.5
    p_no   = np.clip(1 - base, 0, 1)
    s = p_good + p_marg + p_no + 1e-9
    return p_good / s, p_marg / s, p_no / s


def _conf_label(c: float) -> str:
    if c >= 0.80: return "High"
    if c >= 0.55: return "Medium"
    return "Low"


def _resolve_now(mock_now: str | None, offset: int) -> datetime:
    """Return a naive datetime in the location's local time.

    If mock_now is given it must be an ISO string like 2026-11-24T00:39 or
    2026-11-24T00:39:00. Invalid values raise a 422 instead of silently
    falling back to the real clock.
    """
    if mock_now:
        try:
            clean = mock_now.replace("Z", "").strip()[:19]  # YYYY-MM-DDTHH:MM[:SS]
            now = datetime.fromisoformat(clean)
            log.info("mock_now applied: %s", now)
            return now
        except Exception as e:
            log.warning("Invalid mock_now %r: %s", mock_now, e)
            raise HTTPException(status_code=422, detail=f"Invalid mock_now '{mock_now}': {e}")
    return (datetime.now(timezone.utc) + timedelta(seconds=offset)).replace(tzinfo=None)


@app.post("/api/analyze")
async def analyze(req: Req):
    # 1. Fetch forecast
    async with httpx.AsyncClient(timeout=30) as client:
        r = await client.get(
            "https://api.open-meteo.com/v1/forecast",
            params={
                "latitude": req.latitude, "longitude": req.longitude,
                "hourly": "shortwave_radiation,precipitation_probability",
                "forecast_days": req.forecast_days, "timezone": "auto",
            },
        )
        r.raise_for_status()
        data = r.json()

    df = pl.DataFrame(data["hourly"]).rename({
        "shortwave_radiation": "ghi",
        "precipitation_probability": "precip",
    }).with_columns([
        pl.col("ghi").fill_null(0.0),
        pl.col("precip").fill_null(0.0),
        pl.col("time").str.to_datetime().dt.hour().alias("hour"),
    ])

    # 2. Model → per-hour probabilities
    if ARTIFACT is not None:
        model   = ARTIFACT["model"]
        classes = list(ARTIFACT["classes"])
        floor   = float(ARTIFACT["floor"])
        good    = float(ARTIFACT["good"])
        feats   = ARTIFACT.get("features", ["hour", "ghi", "rain"])

        df = df.rename({"precip": "rain"})
        X = df.select(feats).to_numpy().astype(float)
        proba = model.predict_proba(X)
        col = {c: proba[:, classes.index(c)] if c in classes
               else np.zeros(len(df)) for c in CANONICAL}
        p_good, p_marg, p_no = col["GOOD"], col["MARGINAL"], col["NO"]
        model_loaded = True
    else:
        floor, good = FALLBACK_FLOOR, FALLBACK_GOOD
        ghi  = df["ghi"].to_numpy().astype(float)
        rain = df["precip"].to_numpy().astype(float)
        p_good, p_marg, p_no = _fallback_proba(ghi, rain)
        df = df.rename({"precip": "rain"})
        model_loaded = False

    utility    = 1.0 * p_good + 0.5 * p_marg + 0.0 * p_no
    confidence = np.maximum(np.maximum(p_good, p_marg), p_no)
    conf_labels = [_conf_label(c) for c in confidence]
    verdict = np.array(CANONICAL)[np.argmax(
        np.stack([p_good, p_marg, p_no], axis=1), axis=1)]

    df = df.with_columns([
        pl.Series("p_good", p_good),
        pl.Series("p_marginal", p_marg),
        pl.Series("p_no", p_no),
        pl.Series("score", utility),
        pl.Series("verdict", verdict),
        pl.Series("confidence", confidence),
        pl.Series("confidence_label", conf_labels),
    ]).with_row_index("index")
    rows = df.to_dicts()

    # 3. "Now" index (supports UI mock_now override; invalid values -> 422)
    offset = int(data.get("utc_offset_seconds", 0))
    now = _resolve_now(req.mock_now, offset)

    now_idx = next(
        (i for i, t in enumerate(data["hourly"]["time"])
         if datetime.fromisoformat(t) >= now),
        len(rows) - 1,
    )

    # 4. Utility argmax within the lookahead window, with LEARNED floor
    #    and earliest-peak tie-breaker
    end_idx = min(now_idx + LOOKAHEAD_HOURS, len(rows) - 1)

    run_u = rows[now_idx]["score"] if rows[now_idx]["score"] >= floor else 0.0
    future = [(rows[i]["score"], i) for i in range(now_idx + 1, end_idx + 1)
              if rows[i]["score"] >= floor]

    # Maximize score; break ties by selecting the EARLIEST hour (-i)
    fut_u, fut_i = max(future, key=lambda x: (x[0], -x[1]), default=(0.0, None))

    if run_u > 0 and run_u >= fut_u:
        action, util, h_idx = "run_now", run_u, now_idx
    elif fut_u > 0:
        action, util, h_idx = "wait_until_best", fut_u, fut_i
    else:
        action, util, h_idx = "skip", 0.0, None

    chosen = rows[h_idx] if h_idx is not None else rows[now_idx]

    summary = {
        "peak_ghi":       float(df["ghi"].max()),
        "peak_utility":   float(df["score"].max()),
        "good_hours":     int((df["verdict"] == "GOOD").sum()),
        "marginal_hours": int((df["verdict"] == "MARGINAL").sum()),
        "no_hours":       int((df["verdict"] == "NO").sum()),
    }

    return {
        "location":          req.model_dump(),
        "now_index":         now_idx,
        "now_used":          rows[now_idx]["time"],
        "now_is_mock":       bool(req.mock_now),
        "lookahead_hours":   LOOKAHEAD_HOURS,
        "utc_offset_seconds": offset,
        "model_loaded":      model_loaded,
        "summary":           summary,
        "hourly":            rows,
        "constants": {
            "floor":          round(floor, 3),
            "good_threshold": round(good, 3),
        },
        "decision": {
            "action":           action,
            "utility":          round(float(util), 3),
            "hour_index":       h_idx,
            "hour_time":        rows[h_idx]["time"] if h_idx is not None else None,
            "confidence":       round(float(chosen["confidence"]), 3),
            "confidence_label": chosen["confidence_label"],
            "probabilities": {
                "good":     round(float(chosen["p_good"]), 3),
                "marginal": round(float(chosen["p_marginal"]), 3),
                "no":       round(float(chosen["p_no"]), 3),
            },
            "action_utilities": {
                "run_now":         round(float(run_u), 3),
                "wait_until_best": round(float(fut_u), 3),
                "skip":            0.0,
            },
        },
    }


@app.get("/")
def index():
    return FileResponse("static/index.html")
