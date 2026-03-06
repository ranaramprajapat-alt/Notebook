import json
import re
import threading
import base64
import math
import os
import socket
from io import BytesIO
from collections import Counter
from http import HTTPStatus
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlparse, quote_plus

# Optional libraries
try:
    from PyPDF2 import PdfReader
except ImportError:
    PdfReader = None

try:
    from docx import Document
except ImportError:
    Document = None

try:
    from pptx import Presentation
except ImportError:
    Presentation = None


BASE_DIR = Path(__file__).resolve().parent
DATA_FILE = BASE_DIR / "data.json"
LOCK = threading.Lock()

STOPWORDS = {
    "the","and","for","that","with","from","this","have","are","was","were",
    "been","into","about","your","their","they","them","will","would",
    "could","should","there","what","when","where","which","while","also",
    "than","then","after","before","between","through","using","used","use",
    "into","over","under","most","more","some","many","such","each","other",
    "only","very","much","like","just",
}

CHUNK_SIZE_TOKENS = 90
CHUNK_OVERLAP_TOKENS = 20


# ================================
# State Handling
# ================================

def default_state():
    return {"notebooks": []}


def load_state():
    with LOCK:
        if not DATA_FILE.exists():
            state = default_state()
            DATA_FILE.write_text(json.dumps(state, indent=2))
            return state
        return json.loads(DATA_FILE.read_text())


def save_state(state):
    with LOCK:
        DATA_FILE.write_text(json.dumps(state, indent=2))


# ================================
# Text Utilities
# ================================

def safe_text(value):
    return str(value or "")


def tokenize(text):
    return re.findall(r"[a-zA-Z0-9]+", safe_text(text).lower())


def content_tokens(text):
    return [t for t in tokenize(text) if len(t) > 2 and t not in STOPWORDS]


def split_sentences(text):
    normalized = safe_text(text).replace("\r", "\n")
    out = []
    for line in normalized.split("\n"):
        for part in re.split(r"[.!?]+", line):
            s = part.strip()
            if s:
                out.append(s)
    return out


# ================================
# File Text Extraction
# ================================

def extract_base64_text(b64_data, kind):

    if not b64_data:
        return ""

    try:
        file_data = base64.b64decode(b64_data)

        if kind == "pdf" and PdfReader:
            reader = PdfReader(BytesIO(file_data))
            return "\n".join(p.extract_text() for p in reader.pages if p.extract_text())

        if kind == "docx" and Document:
            doc = Document(BytesIO(file_data))
            return "\n".join(p.text for p in doc.paragraphs)

        if kind == "pptx" and Presentation:
            prs = Presentation(BytesIO(file_data))
            text=[]
            for slide in prs.slides:
                for shape in slide.shapes:
                    if hasattr(shape,"text"):
                        text.append(shape.text)
            return "\n".join(text)

    except Exception as e:
        print("Extraction error:",e)

    return ""


# ================================
# Chunking
# ================================

def chunk_source_text(text):

    chunks=[]
    current=[]
    token_count=0

    for sentence in split_sentences(text):

        tokens=tokenize(sentence)

        if len(tokens)<3:
            continue

        if token_count+len(tokens)>CHUNK_SIZE_TOKENS:

            chunks.append(". ".join(current))

            current=current[-2:]
            token_count=sum(len(tokenize(x)) for x in current)

        current.append(sentence)
        token_count+=len(tokens)

    if current:
        chunks.append(". ".join(current))

    return chunks


# ================================
# Retrieval
# ================================

def build_retrieval_items(sources):

    items=[]

    for source in sources:

        text=safe_text(source.get("text"))

        for chunk in chunk_source_text(text):

            tokens=content_tokens(chunk)

            if tokens:
                items.append({
                    "source":source.get("name","source"),
                    "sentence":chunk,
                    "tokens":tokens
                })

    return items


def build_idf(items):

    doc_count=len(items)
    frequencies=Counter()

    for item in items:
        frequencies.update(set(item["tokens"]))

    return {t:math.log((doc_count+1)/(c+1))+1 for t,c in frequencies.items()}


def rank_sentences(question,sources,top_n=5):

    items=build_retrieval_items(sources)

    if not items:
        return []

    q_tokens=content_tokens(question)

    idf=build_idf(items)

    scores=[]

    for item in items:

        overlap=len(set(q_tokens).intersection(item["tokens"]))

        score=overlap

        if score>0:
            scores.append({
                "score":score,
                "source":item["source"],
                "sentence":item["sentence"]
            })

    scores.sort(key=lambda x:x["score"],reverse=True)

    return scores[:top_n]


# ================================
# Answer Generator
# ================================

def format_answer(question,items):

    lines=["Structured Answer",""]

    lines.append("Question")
    lines.append(f"- {question}")
    lines.append("")
    lines.append("Key Points")

    for i,it in enumerate(items,1):
        lines.append(f"{i}. {it['sentence']}")

    return "\n".join(lines)


def answer_question(question,sources):

    if not sources:
        return {
            "text":"Upload files first.",
            "citations":[]
        }

    top=rank_sentences(question,sources)

    if not top:
        return {
            "text":"No answer found in sources.",
            "citations":[]
        }

    return {
        "text":format_answer(question,top),
        "citations":[x["source"] for x in top]
    }


# ================================
# HTTP Handler
# ================================

class Handler(SimpleHTTPRequestHandler):

    def _json_response(self,payload,status=HTTPStatus.OK):

        body=json.dumps(payload).encode()

        self.send_response(status)
        self.send_header("Content-Type","application/json")
        self.send_header("Content-Length",str(len(body)))
        self.end_headers()

        self.wfile.write(body)

    def _read_json_body(self):

        length=int(self.headers.get("Content-Length",0))

        if not length:
            return {}

        raw=self.rfile.read(length)

        return json.loads(raw.decode())

    def do_GET(self):

        parsed=urlparse(self.path)

        if parsed.path=="/api/state":
            self._json_response(load_state())
            return

        if parsed.path=="/":
            self.path="/index.html"

        return super().do_GET()

    def do_PUT(self):

        if self.path!="/api/state":
            self.send_error(404)
            return

        payload=self._read_json_body()

        save_state(payload)

        self._json_response({"ok":True})

    def do_POST(self):

        parsed=urlparse(self.path)

        payload=self._read_json_body()

        if parsed.path=="/api/answer":

            question=payload.get("question","")
            sources=payload.get("sources",[])

            self._json_response(answer_question(question,sources))
            return

        self.send_error(404)


# ================================
# SERVER STARTUP (FIXED)
# ================================

def run():

    host="0.0.0.0"

    port=int(os.environ.get("PORT",3000))

    server=ThreadingHTTPServer((host,port),Handler)

    print("\nSmart Notebook AI running")
    print(f"Local: http://127.0.0.1:{port}")

    try:
        server.serve_forever()
    except KeyboardInterrupt:
        server.server_close()


if __name__=="__main__":
    run()
