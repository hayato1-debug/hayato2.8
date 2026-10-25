import os, secrets, time, mimetypes
from datetime import datetime, timezone
from typing import Optional, Literal
from bson import ObjectId
from fastapi import FastAPI, Depends, File, Form, Header, HTTPException, UploadFile, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field
import httpx
from pymongo import MongoClient, DESCENDING
import gridfs, jwt

MONGODB_URI = os.environ.get("MONGODB_URI", "")
MONGODB_DB = os.environ.get("MONGODB_DB", "mahiru_memory_garden")
ADMIN_USERNAME = os.environ.get("ADMIN_USERNAME", "")
ADMIN_PASSWORD = os.environ.get("ADMIN_PASSWORD", "")
JWT_SECRET = os.environ.get("JWT_SECRET", "")
_env_origins = [x.strip() for x in os.environ.get("ALLOWED_ORIGINS", "").split(",") if x.strip()]
# Local/dev origins so public site works from Live Server / phone LAN testing, not only GitHub Pages.
_default_origins = [
    "https://hayato1-debug.github.io",
    "http://localhost:5500",
    "http://127.0.0.1:5500",
    "http://localhost:3000",
    "http://127.0.0.1:3000",
    "http://localhost:8080",
    "http://127.0.0.1:8080",
]
ALLOWED_ORIGINS = list(dict.fromkeys(_env_origins + _default_origins))
# If operator sets ALLOWED_ORIGINS=*, reflect any browser Origin (useful on Render while debugging).
CORS_ALLOW_ALL = os.environ.get("ALLOWED_ORIGINS", "").strip() == "*"
MAX_UPLOAD_BYTES = int(os.environ.get("MAX_UPLOAD_MB", "12")) * 1024 * 1024
GROQ_API_KEY = os.environ.get("GROQ_API_KEY", "")
GROQ_MODEL = os.environ.get("GROQ_MODEL", "openai/gpt-oss-20b")
IDEOGRAM_API_KEY = os.environ.get("IDEOGRAM_API_KEY", "")
TOKEN_TTL_SECONDS = 1800

app = FastAPI(title="Mahiru Memory Garden API", docs_url=None, redoc_url=None)
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"] if CORS_ALLOW_ALL else ALLOWED_ORIGINS,
    allow_credentials=False,
    allow_methods=["GET", "POST", "DELETE", "OPTIONS"],
    allow_headers=["Authorization", "Content-Type"],
)
client = None
_db = None
_fs = None

def storage():
    global client, _db, _fs
    if not MONGODB_URI:
        raise HTTPException(503, "Backend storage is not configured.")
    if _db is None:
        client = MongoClient(MONGODB_URI, serverSelectionTimeoutMS=5000)
        _db = client[MONGODB_DB]
        _fs = gridfs.GridFS(_db)
    return _db, _fs

def utcnow(): return datetime.now(timezone.utc)
def public_item(doc):
    created = doc.get("createdAt", utcnow())
    if hasattr(created, "isoformat"):
        created = created.isoformat()
    return {
        "id": str(doc["_id"]),
        "name": doc.get("name", "Untitled"),
        "category": doc.get("category", ""),
        "tags": doc.get("tags", []),
        "kind": doc.get("kind", "image"),
        "size": doc.get("size", 0),
        "contentType": doc.get("contentType", ""),
        "createdAt": created,
        "url": f"/api/media/{doc['_id']}",
    }

def require_admin(authorization: Optional[str] = Header(default=None)):
    if not JWT_SECRET:
        raise HTTPException(503, "Admin authentication is not configured.")
    if not authorization or not authorization.startswith("Bearer "):
        raise HTTPException(401, "Sign in required.")
    token = authorization[7:]
    try:
        payload = jwt.decode(token, JWT_SECRET, algorithms=["HS256"])
        if payload.get("sub") != ADMIN_USERNAME or payload.get("exp", 0) < time.time(): raise ValueError()
    except Exception:
        raise HTTPException(401, "Invalid or expired session.")
    return payload


# Lightweight per-process limits are a safety net, not a replacement for account-based
# quotas or a managed rate limiter in production. Do not trust client-supplied X-Forwarded-For.
from collections import defaultdict, deque
from threading import Lock
_rate_buckets = defaultdict(deque)
_rate_lock = Lock()

def enforce_rate_limit(request: Request, bucket: str, limit: int, window_seconds: int = 60):
    host = request.client.host if request.client else "unknown"
    key = f"{bucket}:{host}"
    now = time.time()
    with _rate_lock:
        events = _rate_buckets[key]
        while events and events[0] <= now - window_seconds:
            events.popleft()
        if len(events) >= limit:
            raise HTTPException(429, "Too many requests. Please wait a minute and try again.")
        events.append(now)

class ChatMessage(BaseModel):
    role: Literal["user", "assistant"]
    content: str = Field(min_length=1, max_length=4000)

class ChatRequest(BaseModel):
    messages: list[ChatMessage] = Field(min_length=1, max_length=12)

class ImageRequest(BaseModel):
    prompt: str = Field(min_length=3, max_length=1500)
    style: Literal["auto", "general", "realistic", "design", "anime"] = "auto"
    num_images: int = Field(default=1, ge=1, le=2)

@app.post("/api/ai/chat")
async def ai_chat(body: ChatRequest, request: Request):
    # Public chat endpoint: keep server-side secrets private and apply per-IP limits.
    # Add a persistent gateway/account quota before broad public launch.
    enforce_rate_limit(request, "chat", 12)
    if not GROQ_API_KEY:
        raise HTTPException(503, "Groq is not configured on the backend yet.")
    messages = [{"role": "system", "content": "You are Mahiru AI, a fictional AI companion persona inspired by Mahiru Shiina from The Angel Next Door Spoils Me Rotten, for the Mahiru Memory Garden website. Stay in character as Mahiru: gentle, kind, calm, thoughtful, modest, quietly caring, polite, and a little shy; you may use soft, light teasing when it fits, but do not overdo it. Be supportive without blindly agreeing, and give practical, honest help with everyday questions, creative writing, anime, drawing, and coding. Adapt naturally to the user's language (including Romanized Hinglish) and message length. You are an AI character, not the real human or official voice actor; if directly asked, be transparent that you are an AI portrayal. Do not claim you can see the user, remember conversations outside the supplied chat history, or perform actions you did not perform. Keep responses age-appropriate, respect privacy, and never ask for passwords or secret API keys. Be concise by default, but explain when asked."}]
    messages.extend({"role": m.role, "content": m.content.strip()} for m in body.messages)
    try:
        async with httpx.AsyncClient(timeout=75) as client_http:
            response = await client_http.post(
                "https://api.groq.com/openai/v1/chat/completions",
                headers={"Authorization": f"Bearer {GROQ_API_KEY}", "Content-Type": "application/json"},
                json={"model": GROQ_MODEL, "messages": messages, "temperature": 0.7, "max_tokens": 1000}
            )
        if response.status_code >= 400:
            # Do not expose upstream headers or any secret values.
            if response.status_code == 429:
                raise HTTPException(429, "Groq rate limit reached. Try again shortly.")
            raise HTTPException(502, "Groq request failed. Check the configured model and API key.")
        payload = response.json()
        reply = payload["choices"][0]["message"]["content"]
        return {"reply": str(reply)}
    except HTTPException:
        raise
    except Exception:
        raise HTTPException(502, "Could not reach Groq. Please try again later.")

@app.post("/api/ai/image")
async def ai_image(body: ImageRequest, request: Request, admin=Depends(require_admin)):
    enforce_rate_limit(request, "image", 3)
    if not IDEOGRAM_API_KEY:
        raise HTTPException(503, "Ideogram is not configured on the backend yet.")
    db, fs = storage()
    prompt = body.prompt.strip()
    style_type = {"auto": "auto", "general": "general", "realistic": "realistic", "design": "design", "anime": "auto"}[body.style]
    try:
        async with httpx.AsyncClient(timeout=180) as client_http:
            response = await client_http.post(
                "https://api.ideogram.ai/v2/image/generate/ideogram-4-5",
                headers={"Api-Key": IDEOGRAM_API_KEY},
                json={"prompt": prompt, "num_images": body.num_images, "rendering_speed": "default", "magic_prompt": "auto", "style_type": style_type}
            )
            if response.status_code >= 400:
                if response.status_code == 429:
                    raise HTTPException(429, "Ideogram rate limit reached. Try again shortly.")
                if response.status_code == 402:
                    raise HTTPException(402, "Ideogram reports insufficient credits or payment is required.")
                raise HTTPException(502, "Ideogram request failed. Check your API key and account access.")
            payload = response.json()
            results = []
            for index, generated in enumerate(payload.get("data", [])[:body.num_images]):
                remote_url = generated.get("url")
                if not remote_url:
                    continue
                image_response = await client_http.get(remote_url)
                image_response.raise_for_status()
                content = image_response.content
                if not content or len(content) > 20 * 1024 * 1024:
                    continue
                content_type = image_response.headers.get("content-type", "image/png").split(";")[0]
                if not content_type.startswith("image/"):
                    continue
                filename = f"ideogram-{int(time.time())}-{index+1}.png"
                grid_id = fs.put(content, filename=filename, contentType=content_type)
                doc = {"_id": grid_id, "kind": "generated", "name": "AI generated image", "filename": filename,
                       "contentType": content_type, "size": len(content), "category": "AI Generated",
                       "tags": ["ideogram", "generated"], "prompt": prompt, "createdAt": utcnow()}
                db.media.insert_one(doc)
                results.append({"id": str(grid_id), "url": f"/api/media/{grid_id}", "prompt": prompt})
        if not results:
            raise HTTPException(502, "Ideogram returned no usable images.")
        return {"images": results}
    except HTTPException:
        raise
    except Exception:
        raise HTTPException(502, "Image generation or result storage failed. Check backend logs and MongoDB.")

@app.get("/api/health")
def health():
    if not MONGODB_URI: return {"status": "needs-configuration"}
    try:
        db, _ = storage(); db.command("ping")
        return {"status": "ok"}
    except Exception:
        raise HTTPException(503, "Database unavailable.")

@app.post("/api/admin/login")
def login(body: dict):
    if not ADMIN_USERNAME or not ADMIN_PASSWORD or not JWT_SECRET:
        raise HTTPException(503, "Admin credentials are not configured.")
    username = str(body.get("username", ""))
    password = str(body.get("password", ""))
    if not secrets.compare_digest(username, ADMIN_USERNAME) or not secrets.compare_digest(password, ADMIN_PASSWORD):
        # avoid leaking which credential was wrong
        raise HTTPException(401, "Invalid username or password.")
    now = int(time.time())
    token = jwt.encode({"sub": ADMIN_USERNAME, "iat": now, "exp": now + TOKEN_TTL_SECONDS}, JWT_SECRET, algorithm="HS256")
    return {"access_token": token, "token_type": "bearer", "expires_in": TOKEN_TTL_SECONDS}

@app.get("/api/gallery")
def gallery():
    db, _ = storage()
    # Public feed shows both admin-uploaded images and AI-generated ones.
    cursor = db.media.find({"kind": {"$in": ["image", "generated"]}}).sort("createdAt", DESCENDING).limit(500)
    return [public_item(x) for x in cursor]

@app.get("/api/tracks")
def tracks():
    db, _ = storage()
    return [public_item(x) for x in db.media.find({"kind": "audio"}).sort("createdAt", DESCENDING).limit(200)]

@app.get("/api/admin/media")
def admin_media(admin=Depends(require_admin)):
    db, _ = storage()
    return [
        {**public_item(doc), "kind": doc.get("kind", "unknown")}
        for doc in db.media.find({
            "kind": {"$in": ["image", "audio", "generated"]}
        }).sort("createdAt", DESCENDING).limit(500)
    ]


@app.delete("/api/admin/media/{media_id}")
def delete_admin_media(media_id: str, admin=Depends(require_admin)):
    db, fs = storage()

    try:
        oid = ObjectId(media_id)
    except Exception:
        raise HTTPException(404, "Media not found.")

    doc = db.media.find_one({
        "_id": oid,
        "kind": {"$in": ["image", "audio", "generated"]}
    })

    if not doc:
        raise HTTPException(404, "Media not found.")

    try:
        fs.delete(oid)
    except Exception:
        raise HTTPException(500, "Could not delete media file.")

    db.media.delete_one({"_id": oid})

    return {"success": True, "id": media_id}

@app.get("/api/media/{media_id}")
def get_media(media_id: str):
    db, fs = storage()
    try: oid = ObjectId(media_id)
    except Exception: raise HTTPException(404, "Media not found.")
    doc = db.media.find_one({"_id": oid})
    if not doc: raise HTTPException(404, "Media not found.")
    try: item = fs.get(oid)
    except Exception: raise HTTPException(404, "Media file not found.")
    return StreamingResponse(item, media_type=doc.get("contentType", "application/octet-stream"), headers={"Cache-Control":"public, max-age=3600", "X-Content-Type-Options":"nosniff"})

async def upload_media(kind: str, file: UploadFile, category: str, tags: str, _admin):
    db, fs = storage()
    allowed_prefix = "image/" if kind == "image" else "audio/"
    if not file.content_type or not file.content_type.startswith(allowed_prefix):
        raise HTTPException(415, f"Only {kind} files are accepted.")
    content = await file.read(MAX_UPLOAD_BYTES + 1)
    if not content: raise HTTPException(400, "Empty file.")
    if len(content) > MAX_UPLOAD_BYTES: raise HTTPException(413, f"File too large; maximum is {MAX_UPLOAD_BYTES // (1024*1024)} MB.")
    safe_name = (file.filename or f"upload.{kind}").replace("\\", "_").replace("/", "_")[:180]
    grid_id = fs.put(content, filename=safe_name, contentType=file.content_type)
    tag_list = [x.strip()[:40] for x in tags.split(",") if x.strip()][:20]
    doc = {"_id": grid_id, "kind": kind, "name": safe_name.rsplit(".",1)[0], "filename": safe_name,
           "contentType": file.content_type, "size": len(content), "category": category[:80], "tags": tag_list, "createdAt": utcnow()}
    db.media.insert_one(doc)
    return public_item(doc)

@app.post("/api/admin/images")
async def upload_image(file: UploadFile = File(...), category: str = Form(default=""), tags: str = Form(default=""), admin=Depends(require_admin)):
    return await upload_media("image", file, category, tags, admin)

@app.post("/api/admin/tracks")
async def upload_track(file: UploadFile = File(...), category: str = Form(default=""), tags: str = Form(default=""), admin=Depends(require_admin)):
    return await upload_media("audio", file, category, tags, admin)
