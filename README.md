# AI Avatar V1

## Overview

AI Avatar V1 is a locally hosted, real-time conversational avatar that combines speech, vision, and personality-driven interaction.

It allows you to speak naturally to an on-screen avatar that can:
- listen
- respond
- see via camera
- remember within a conversation

---

## Features

- Real-time speech input (microphone)
- Speech-to-text using whisper.cpp
- Local LLM via vLLM (Qwen VL)
- Camera-based vision understanding
- Short-term conversational memory
- Text-to-speech using Piper
- Animated avatar with:
  - body movement
  - blinking
  - lip sync

---

## Architecture (V1)

User Speech → Transcription → LLM → Response → Speech Output  
                                     ↑  
                             Optional Vision Input  

---

## Core Components

### Backend
- FastAPI server (`server.py`)
- vLLM serving a multimodal model (Qwen VL)

### Frontend
- HTML / CSS / JavaScript
- Real-time audio + camera capture
- Avatar animation

### Speech
- whisper.cpp (speech-to-text)
- Piper (text-to-speech)

### Vision
- Webcam input
- Base64 frame capture
- Selective use based on user intent

---

## What Is NOT Included

This repository does not include:

- Model files
- whisper.cpp binaries
- Piper binaries
- Generated audio files
- Camera images or recordings

---

## Required Components (Local Setup)

You will need to install:

- vLLM
- Qwen VL model
- whisper.cpp
- Piper TTS

These must be configured locally.

---

## Folder Structure (Expected)

```
/static/
  app.js
  style.css
  /frames/

/models/
/tts/
/whisper/
```

---

## Notes

- All processing is local
- No external APIs required
- Vision is only used when relevant to the user’s question
- Memory is session-based (no persistence)

---

## Version

This is **Version 1 (V1)** — a baseline system.

Future versions will introduce:
- control layer
- multi-model routing
- structured memory
- improved speech and personality
