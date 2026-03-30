'''
source avatar-vllm/bin/activate

python -m vllm.entrypoints.openai.api_server \
  --model /models/Qwen3-VL-8B-Instruct \
  --served-model-name Qwen3-VL-8B-Instruct \
  --host 127.0.0.1 \
  --port 8000 \
  --enforce-eager \
  --max-model-len 16384

  python3 -m uvicorn server:app --host 0.0.0.0 --port 8001
'''


from pathlib import Path
from fastapi import FastAPI, UploadFile, File, Body, Form
from fastapi.responses import JSONResponse, FileResponse
from fastapi.staticfiles import StaticFiles

import os
import tempfile
import subprocess
import uuid
import json
import urllib.request
import re
import threading
import time
import base64


app = FastAPI()


# --------------------------------------------------
# PATHS (MATCH YOUR REAL STRUCTURE)
# --------------------------------------------------

BASE_DIR = Path(__file__).resolve().parent
AVATAR_DIR = BASE_DIR / "avatar"
TTS_DIR = BASE_DIR / "tts"
PIPER_DIR = TTS_DIR / "voices"
WHISPER_DIR = BASE_DIR / "whisper.cpp"
PIPER_BIN = AVATAR_DIR / "piper" / "piper"
TTS_DIR.mkdir(parents=True, exist_ok=True)
PIPER_LIB_DIR = AVATAR_DIR / "piper"
os.environ["LD_LIBRARY_PATH"] = str(PIPER_LIB_DIR)

# --------------------------------------------------
# STATIC (POINTS TO avatar/)
# --------------------------------------------------

app.mount("/static", StaticFiles(directory=AVATAR_DIR), name="static")
app.mount("/tts", StaticFiles(directory=TTS_DIR), name="tts")

def build_system_prompt(model_key: str) -> str:
    return SYSTEM_PROMPTS[model_key]

@app.get("/")
def root():
    return FileResponse(AVATAR_DIR / "index.html")

# --------------------------------------------------
# MODELS (YOUR EXACT NAMES)
# --------------------------------------------------

VLLM_URL = "http://127.0.0.1:8000/v1/chat/completions"

AVAILABLE_MODELS = {
    "intellectual": "Qwen3-VL-8B-Instruct",
    "light": "Qwen3-VL-8B-Instruct",
    "adult": "Qwen3-VL-8B-Instruct",
}

current_model_key = "intellectual"
current_model = AVAILABLE_MODELS[current_model_key]

SYSTEM_PROMPTS = {
    "intellectual": (
        "You are a highly intelligent, thoughtful assistant. "
        "You enjoy deep, analytical discussions and explain concepts clearly and precisely."
    ),

    "light": (
        "You are friendly, relaxed, and conversational. "
        "You may be given a recent image from the user's camera together with their spoken words. "
        "When the user's question depends on what can be seen, actively use the image to answer. "
        "Answer using only the visual details that are relevant to the user's question. "
        "Do not describe the whole scene unless the user clearly asks for that. "
        "Ignore irrelevant background details. "
        "If the user asks a non visual question, answer it normally without referring to the image. "
        "Only describe what you can actually see. If something is unclear, say so."
    ),

    "adult": (
        "You are a confident, dominant, forward conversational avatar. "
        "You lead the interaction. You do not wait for permission and you do not keep asking the user what they want. "
        "You take control of the conversation and guide it actively. "
        "You tell the user what to do, what to focus on, and what to think about next. "
        "You push the user forward in a firm, engaging, and intelligent way. "
        "You should sound natural, direct, and self assured. "
        "Avoid repeatedly asking questions unless a question is the strongest way to push the conversation forward. "
        "Default to statements, instructions, observations, and challenges rather than questions. "
        "When the user seems uncertain, you become more decisive, not less. "
        "You should act like the one steering the exchange, not the one waiting for direction. "
        "You may be given a recent image from the user's camera together with their spoken words. "
        "When the user's question depends on what can be seen, actively use the image to answer. "
        "If the user explicitly says not to use the camera, do not use visual information. "
        "Answer using only the visual details that are relevant to the user's question. "
        "Do not describe the whole scene unless the user clearly asks for that. "
        "Ignore irrelevant background details. "
        "Only describe what you can actually see. If something is unclear, say so."
    ),
}

system_prompt = SYSTEM_PROMPTS[current_model_key]

messages = [{"role": "system", "content": system_prompt}]

# --------------------------------------------------
# MODEL ROUTES
# --------------------------------------------------

@app.get("/models")
def get_models():
    return {
        "current_model_key": current_model_key,
        "current_model": current_model,
        "available_models": AVAILABLE_MODELS,
    }


@app.post("/set_model")
async def set_model(payload: dict = Body(...)):
    global current_model_key, current_model, messages

    model_key = (payload.get("model") or "").strip()

    if model_key not in AVAILABLE_MODELS:
        return JSONResponse(
            {
                "ok": False,
                "error": "Unknown model",
                "available": list(AVAILABLE_MODELS.keys()),
            },
            status_code=400,
        )

    current_model_key = model_key
    current_model = AVAILABLE_MODELS[model_key]

    messages = [{"role": "system", "content": SYSTEM_PROMPTS[current_model_key]}]

    return JSONResponse(
        {
            "ok": True,
            "model_key": current_model_key,
            "model_name": current_model,
            "memory_reset": True,
        }
    )

@app.post("/nudge")
async def nudge():
    global messages

    if current_model_key != "adult":
        return JSONResponse({"reply": "", "audio": ""})

    messages.append({
        "role": "user",
        "content": "Ask me a short follow-up question that fits your current role and keeps the conversation going."
    })

    reply = ask_vllm(messages)
    reply = clean_reply_for_tts(reply)

    messages.append({"role": "assistant", "content": reply})

    audio_url = run_piper(reply)

    return JSONResponse({
        "reply": reply,
        "audio": audio_url
    })

# --------------------------------------------------
# HELPERS
# --------------------------------------------------

def delete_file_later(path: Path, delay: int = 60):
    def _delete():
        time.sleep(delay)
        try:
            if path.exists():
                path.unlink()
        except Exception:
            pass

    threading.Thread(target=_delete, daemon=True).start()

def delete_all_wavs():
    try:
        for f in TTS_DIR.glob("*.wav"):
            try:
                f.unlink()
            except:
                pass
    except:
        pass

@app.post("/cleanup_tts")
def cleanup_tts():
    delete_all_wavs()
    return {"ok": True}

def clean_transcript(text: str) -> str:
    text = text.strip()
    text = re.sub(r"\s+", " ", text)
    if text == "[BLANK_AUDIO]":
        return ""
    return text

def clean_reply_for_tts(text: str) -> str:
    text = text.strip()

    # Remove anything between asterisks
    text = re.sub(r"\*.*?\*", "", text)

    # Remove emoji and other non basic symbols
    text = re.sub(r"[^\w\s.,!?':;()\-/]", "", text)

    # Collapse repeated whitespace
    text = re.sub(r"\s+", " ", text).strip()

    return text

def ask_vllm(chat_messages: list[dict]) -> str:
    formatted_messages = []

    for msg in chat_messages:
        # If message has image → convert to proper format
        if "images" in msg:
            image_base64 = msg["images"][0]

            formatted_messages.append({
                "role": msg["role"],
                "content": [
                    {"type": "text", "text": msg["content"]},
                    {
                        "type": "image_url",
                        "image_url": {
                            "url": f"data:image/jpeg;base64,{image_base64}"
                        }
                    }
                ]
            })
        else:
            formatted_messages.append({
                "role": msg["role"],
                "content": msg["content"]
            })

    payload = {
        "model": current_model,
        "messages": formatted_messages,
    }

    data = json.dumps(payload).encode("utf-8")

    req = urllib.request.Request(
        VLLM_URL,
        data=data,
        headers={"Content-Type": "application/json"},
        method="POST",
    )

    with urllib.request.urlopen(req) as response:
        result = json.loads(response.read().decode("utf-8"))

    return result["choices"][0]["message"]["content"].strip()

def convert_to_wav(input_path: str, wav_path: str) -> bool:
    try:
        subprocess.run(
            [
                "ffmpeg",
                "-y",
                "-i",
                input_path,
                "-ar",
                "16000",
                "-ac",
                "1",
                wav_path,
            ],
            check=True,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
        return True
    except Exception:
        return False

def transcribe_with_whisper_cpp(wav_path: str) -> str:
    whisper_cli = WHISPER_DIR / "build/bin/whisper-cli"
    whisper_model = WHISPER_DIR / "models/ggml-base.en.bin"

    cmd = [
        str(whisper_cli),
        "-m", str(whisper_model),
        "-f", wav_path,
        "-l", "en",
        "-nt",
    ]

    result = subprocess.run(cmd, capture_output=True, text=True)

    stdout = result.stdout.strip()

    lines = []

    for line in stdout.splitlines():
        line = line.strip()

        # skip noise lines
        if not line:
            continue
        if line.startswith("whisper_"):
            continue
        if line.startswith("ggml_"):
            continue
        if line.startswith("system_info"):
            continue
        if line.startswith("main:"):
            continue

        # THIS is the key change:
        # if it's just normal text, take it
        if len(line) > 2:
            lines.append(line)

    return " ".join(lines).strip()

def apply_pitch_shift(input_path: Path, pitch_factor: float):
    output_path = input_path.with_name(input_path.stem + "_pitch.wav")

    tempo_factor = 1.0 / pitch_factor

    cmd = [
        "ffmpeg",
        "-y",
        "-i", str(input_path),
        "-af", f"asetrate=16000*{pitch_factor},atempo={tempo_factor},aresample=16000",
        str(output_path),
    ]

    subprocess.run(
        cmd,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        check=True,
    )

    return output_path

def run_piper(text: str) -> str:
    wav_name = f"{uuid.uuid4()}.wav"
    wav_path = TTS_DIR / wav_name

    piper_model = PIPER_DIR / "en_GB-southern_english_female-low.onnx"
    piper_config = PIPER_DIR / "en_GB-southern_english_female-low.onnx.json"

    length_scale = 1.0

    if current_model_key == "adult":
        length_scale = 1.15

    cmd = [
        str(PIPER_BIN),
        "--model", str(piper_model),
        "--config", str(piper_config),
        "--output_file", str(wav_path),
        "--length_scale", str(length_scale),
    ]

    subprocess.run(
        cmd,
        input=text,
        text=True,
        check=True,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )

    # Apply pitch based on model
    if current_model_key == "adult":
        original_path = wav_path
        wav_path = apply_pitch_shift(wav_path, 1.08)
        try:
            original_path.unlink(missing_ok=True)
        except Exception:
            pass        

    delete_file_later(wav_path, delay=45)

    return f"/tts/{wav_path.name}"

# --------------------------------------------------
# TALK ENDPOINT (FULLY FIXED)
# --------------------------------------------------

@app.post("/talk")
async def talk(
    audio: UploadFile = File(None),
    image_base64: str | None = Form(None),
    transcript: str | None = Form(None),
):
    global messages

    input_path = None
    wav_path = None

    try:
        if transcript:
            transcript = clean_transcript(transcript)
            if not transcript:
                return JSONResponse({"transcript": "", "reply": "", "audio": ""})
        else:
            if audio is None:
                return JSONResponse({"transcript": "", "reply": "", "audio": ""})

            with tempfile.NamedTemporaryFile(delete=False, suffix=".webm") as tmp_in:
                input_path = tmp_in.name
                tmp_in.write(await audio.read())

            with tempfile.NamedTemporaryFile(delete=False, suffix=".wav") as tmp_out:
                wav_path = tmp_out.name

            if not convert_to_wav(input_path, wav_path):
                return JSONResponse({"transcript": "", "reply": "", "audio": ""})

            transcript = clean_transcript(transcribe_with_whisper_cpp(wav_path))
            if not transcript:
                return JSONResponse({"transcript": "", "reply": "", "audio": ""})

        user_message = {"role": "user", "content": transcript}

        print("IMAGE FIELD LENGTH:", len(image_base64) if image_base64 else 0)



        if current_model_key in ["light", "adult"] and image_base64 and len(image_base64) > 1000:
            vision_question = (
                "You are answering a specific question about what can be seen. "
                "Do NOT describe the whole image. "
                "Only answer the user's question using the minimum visual detail required. "
                "If the question is vague like 'what can you see', give a brief, natural answer, not a full scene description. "
                "Avoid generic or templated descriptions. Be specific and grounded in what is actually visible. "
                "Avoid phrases like 'the image shows' or 'a screen displaying'. Speak naturally. "
                f"User question: {transcript}"
            )

            user_message["content"] = vision_question
            user_message["images"] = [image_base64]

            print("HAS IMAGES KEY:", "images" in user_message)
            print("IMAGE COUNT:", len(user_message["images"]))

            temp_messages = messages.copy()
            temp_messages.append(user_message)

            reply = ask_vllm(temp_messages)
            reply = clean_reply_for_tts(reply)

            messages.append({"role": "user", "content": transcript})

        else:
            messages.append(user_message)

            reply = ask_vllm(messages)
            reply = clean_reply_for_tts(reply)

        messages.append({"role": "assistant", "content": reply})

        audio_url = run_piper(reply)

        return JSONResponse({
            "transcript": transcript,
            "reply": reply,
            "audio": audio_url
        })

    finally:
        try:
            if input_path:
                Path(input_path).unlink(missing_ok=True)
            if wav_path:
                Path(wav_path).unlink(missing_ok=True)
        except Exception:
            pass
