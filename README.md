# ☀️ SolarCast — Solar Utility Agent

A small web app that reads the hourly weather forecast from **Open-Meteo** and tells you **the best hour to run solar-powered equipment** — a pump, a charger, a battery, or anything that depends on sunshine.

A logistic-regression model predicts, for every hour, how likely conditions will be **GOOD**, **MARGINAL**, or **NO** for solar use. Those probabilities combine into a **utility score** (0–1), and the app picks between three actions: **run now**, **wait for a better hour**, or **skip**.

---

## ✨ Features

- 📍 **Location presets** — Seri Iskandar, Kuala Lumpur, Penang, Johor Bahru, or custom coordinates
- 📅 **1–16 day** forecast horizon
- 🤖 **Learned model** (`solar_model.pkl`) with a **graceful fallback heuristic** if the model file is missing
- 🎯 **Utility-based decision**: `argmax{ run_now, wait_until_best, skip }` using a learned FLOOR threshold
- 📊 **Interactive chart** (Chart.js) showing utility + GHI with GOOD/FLOOR annotations and a "★ chosen hour" marker
- 📋 **Hour-by-hour table** with verdict badges and confidence pills
- 💡 **Beginner-friendly primer** + glossary built into the UI
- 🌗 **Warm dark UI**, responsive down to mobile

---

## 🧠 How it works (technical)

1. The frontend POSTs `{ latitude, longitude, forecast_days }` to `/api/analyze`.
2. The backend fetches hourly `shortwave_radiation` (GHI) and `precipitation_probability` from [Open-Meteo](https://open-meteo.com/).
3. A model (loaded from `solar_model.pkl` via `joblib`) predicts class probabilities for each hour:
   ```
   P(GOOD), P(MARGINAL), P(NO)
   ```
4. Utility is computed as:
   ```
   utility(h) = 1.0 · P(GOOD) + 0.5 · P(MARGINAL) + 0.0 · P(NO)
   ```
5. The app picks the action with the highest utility:
   - `run_now` — current hour's utility ≥ **FLOOR** and beats any future hour (ties → run now)
   - `wait_until_best` — a future hour clears FLOOR and beats now
   - `skip` — no hour clears FLOOR
6. Confidence = max probability; labelled **High ≥ 0.80**, **Medium ≥ 0.55**, else **Low**.

If `solar_model.pkl` is missing, a simple heuristic (`_fallback_proba`) is used and the UI shows a yellow warning banner.

---

## 📦 Prerequisites

- Python **3.8+**
- pip
- Git (optional)

---

## 🚀 Installation

1. **Clone the repo**
   ```bash
   git clone https://github.com/hasifcodes-beep/SolarCast.git
   cd SolarCast
   ```

2. **Create and activate a virtual environment**
   ```bash
   # macOS / Linux
   python3 -m venv venv
   source venv/bin/activate

   # Windows
   python -m venv venv
   .\venv\Scripts\activate
   ```

3. **Install dependencies**
   ```bash
   pip install -r requirements.txt
   ```
   Required packages: `fastapi`, `uvicorn`, `httpx`, `joblib`, `numpy`, `polars`, `pydantic`, `scikit-learn`.

---

## ▶️ Running the app

```bash
uvicorn main:app --reload
```

Then open:

| URL | What |
|---|---|
| [http://127.0.0.1:8000](http://127.0.0.1:8000) | The web UI |
| [http://127.0.0.1:8000/docs](http://127.0.0.1:8000/docs) | Auto-generated FastAPI docs |

The `--reload` flag is optional (useful during development).

---

## 🗂️ Project structure

```
SolarCast/
├── main.py                # FastAPI app + decision logic
├── solar_model.pkl        # Pre-trained joblib artifact
│                          #   { model, classes, floor, good, features }
├── requirements.txt
├── static/
│   ├── index.html         # Frontend markup
│   ├── app.js             # Fetch + render logic
│   └── style.css          # Warm dark theme
└── README.md
```

> 🛈 If you have a `train_model.ipynb` in the repo, run it to (re)generate `solar_model.pkl`, then restart the server.

---

## 🔌 API

### `POST /api/analyze`

**Request body**
```json
{
  "latitude": 4.3596,
  "longitude": 100.9761,
  "forecast_days": 7
}
```

**Response (trimmed)**
```json
{
  "location": { "latitude": 4.3596, "longitude": 100.9761, "forecast_days": 7 },
  "now_index": 14,
  "model_loaded": true,
  "summary": {
    "peak_ghi": 892.0,
    "peak_utility": 0.87,
    "good_hours": 41,
    "marginal_hours": 60,
    "no_hours": 67
  },
  "constants": { "floor": 0.34, "good_threshold": 0.61 },
  "hourly": [
    {
      "index": 0,
      "time": "2025-01-01T00:00",
      "ghi": 0.0,
      "rain": 12.0,
      "p_good": 0.02,
      "p_marginal": 0.18,
      "p_no": 0.80,
      "score": 0.11,
      "verdict": "NO",
      "confidence": 0.80,
      "confidence_label": "High"
    }
  ],
  "decision": {
    "action": "wait_until_best",
    "utility": 0.87,
    "hour_index": 23,
    "hour_time": "2025-01-01T13:00",
    "confidence": 0.91,
    "confidence_label": "High",
    "probabilities": { "good": 0.86, "marginal": 0.09, "no": 0.05 },
    "action_utilities": {
      "run_now": 0.0,
      "wait_until_best": 0.87,
      "skip": 0.0
    }
  }
}
```

### `GET /`
Serves `static/index.html`.

---

## 🧪 Quick test via curl

```bash
curl -X POST http://127.0.0.1:8000/api/analyze \
  -H "Content-Type: application/json" \
  -d '{"latitude":4.3596,"longitude":100.9761,"forecast_days":3}'
```

---

## 🛠️ Troubleshooting

| Problem | Fix |
|---|---|
| Yellow banner: *solar_model.pkl not found* | Add the `.pkl` file to the project root (or run the training notebook) and restart uvicorn |
| `ModuleNotFoundError: polars` (or similar) | `pip install -r requirements.txt` inside the activated venv |
| `RuntimeError: Directory 'static' does not exist` | Run uvicorn from the repo root, not from inside `static/` |
| Open-Meteo request times out | Check your network; the app has a 30 s timeout |

---

## ⚠️ Disclaimer

This is a **simple forecast-based awareness tool**. It is **not** a measurement, a savings guarantee, or engineering advice.

---

## 📜 License

See the repository for license details.
