from pathlib import Path
import base64
import logging
import threading

import cv2
import numpy as np
from fastapi import FastAPI, File, HTTPException, UploadFile, WebSocket
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import HTMLResponse
from starlette.concurrency import run_in_threadpool
from starlette.websockets import WebSocketDisconnect
from ultralytics import YOLO

# ============================================================
# SI-PILAH BACKEND
# ============================================================
BASE_DIR = Path(__file__).resolve().parent
MODEL_PATH = BASE_DIR / "best.pt"

# Upload foto memakai ambang awal yang sama dengan pengujian sebelumnya.
UPLOAD_CONFIDENCE = 0.25
UPLOAD_IMAGE_SIZE = 640

# Kamera memakai ambang sedikit lebih tinggi untuk mengurangi beberapa
# deteksi latar belakang ber-confidence sangat rendah. Ini perlu diuji lagi.
CAMERA_CONFIDENCE = 0.60
CAMERA_IMAGE_SIZE = 640

MAX_UPLOAD_SIZE = 15 * 1024 * 1024  # 15 MB
MAX_CAMERA_FRAME_SIZE = 3 * 1024 * 1024  # 3 MB per frame

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("si-pilah")

if not MODEL_PATH.exists():
    raise FileNotFoundError(f"Model tidak ditemukan: {MODEL_PATH}")

# Muat model sekali saat server dimulai.
model = YOLO(str(MODEL_PATH))
model_lock = threading.Lock()

app = FastAPI(
    title="SI-PILAH API",
    description="API Deteksi Sampah Organik dan Anorganik",
    version="1.1.0",
)

# Pengaturan ini untuk pengembangan lokal. Saat hosting, batasi origins
# ke domain frontend yang benar.
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)


def run_prediction(image: np.ndarray, confidence: float, image_size: int, include_image: bool = False):
    """Jalankan satu prediksi YOLO dan bentuk respons yang dipakai frontend."""
    height, width = image.shape[:2]

    with model_lock:
        result = model.predict(
            source=image,
            conf=confidence,
            imgsz=image_size,
            device="cpu",
            verbose=False,
        )[0]

    detections = []
    for box in result.boxes:
        x1, y1, x2, y2 = box.xyxy[0].tolist()
        class_id = int(box.cls[0].item())
        score = float(box.conf[0].item())
        detections.append({
            "class_id": class_id,
            "class_name": str(model.names[class_id]),
            "confidence": round(score, 4),
            "x1": round(x1, 2),
            "y1": round(y1, 2),
            "x2": round(x2, 2),
            "y2": round(y2, 2),
        })

    response = {
        "success": True,
        "image_width": width,
        "image_height": height,
        "total_objects": len(detections),
        "detections": detections,
    }

    if include_image:
        annotated = result.plot()
        ok, buffer = cv2.imencode(".jpg", annotated)
        if not ok:
            raise ValueError("Gagal membuat gambar hasil deteksi.")
        encoded = base64.b64encode(buffer.tobytes()).decode("ascii")
        response["annotated_image"] = "data:image/jpeg;base64," + encoded

    return response


@app.get("/", response_class=HTMLResponse)
async def home():
    return """
    <h2>SI-PILAH API</h2>
    <p>Backend deteksi sampah berhasil dijalankan.</p>
    <p><a href='/docs'>Buka dokumentasi API</a></p>
    """


@app.get("/api/health")
async def health():
    return {
        "success": True,
        "message": "SI-PILAH API aktif",
        "model_loaded": True,
        "task": model.task,
        "classes": model.names,
        "device": "cpu",
        "camera_confidence": CAMERA_CONFIDENCE,
        "camera_image_size": CAMERA_IMAGE_SIZE,
    }


@app.post("/api/detect")
async def detect_upload(file: UploadFile = File(...)):
    allowed_types = {"image/jpeg", "image/png", "image/webp"}
    if file.content_type not in allowed_types:
        raise HTTPException(status_code=400, detail="Format foto harus JPG, PNG, atau WEBP.")

    raw = await file.read(MAX_UPLOAD_SIZE + 1)
    if len(raw) > MAX_UPLOAD_SIZE:
        raise HTTPException(status_code=413, detail="Ukuran foto maksimal 15 MB.")
    if not raw:
        raise HTTPException(status_code=400, detail="File foto kosong.")

    image = cv2.imdecode(np.frombuffer(raw, dtype=np.uint8), cv2.IMREAD_COLOR)
    if image is None:
        raise HTTPException(status_code=400, detail="Gambar tidak dapat dibaca.")

    try:
        result = await run_in_threadpool(
            run_prediction, image, UPLOAD_CONFIDENCE, UPLOAD_IMAGE_SIZE, True
        )
        result["filename"] = file.filename
        return result
    except Exception as exc:
        logger.exception("Kesalahan saat mendeteksi upload foto")
        raise HTTPException(status_code=500, detail="Terjadi kesalahan saat memproses gambar.") from exc


@app.websocket("/ws/detect")
async def detect_camera(websocket: WebSocket):
    await websocket.accept()
    logger.info("Koneksi kamera dibuka")
    try:
        while True:
            raw = await websocket.receive_bytes()
            if not raw:
                continue
            if len(raw) > MAX_CAMERA_FRAME_SIZE:
                await websocket.send_json({"success": False, "error": "Frame kamera terlalu besar."})
                continue

            image = cv2.imdecode(np.frombuffer(raw, dtype=np.uint8), cv2.IMREAD_COLOR)
            if image is None:
                await websocket.send_json({"success": False, "error": "Frame kamera tidak dapat dibaca."})
                continue

            result = await run_in_threadpool(
                run_prediction, image, CAMERA_CONFIDENCE, CAMERA_IMAGE_SIZE, False
            )
            await websocket.send_json(result)

    except WebSocketDisconnect:
        logger.info("Koneksi kamera ditutup pengguna")
    except Exception:
        logger.exception("Kesalahan pada WebSocket kamera")
        try:
            await websocket.close(code=1011)
        except Exception:
            pass


if __name__ == "__main__":
    import uvicorn
    uvicorn.run("main:app", host="127.0.0.1", port=8000, reload=False)
