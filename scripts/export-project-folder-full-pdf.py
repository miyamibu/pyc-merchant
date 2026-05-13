#!/usr/bin/env python3

import argparse
import base64
import hashlib
import json
import os
import shutil
import tempfile
import unicodedata
from datetime import datetime
from pathlib import Path

from reportlab.lib.pagesizes import A3, landscape
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.cidfonts import UnicodeCIDFont
from reportlab.pdfgen import canvas


TEXT_EXTENSIONS = {
    ".md",
    ".txt",
    ".log",
    ".json",
    ".jsonl",
    ".yaml",
    ".yml",
    ".toml",
    ".ini",
    ".conf",
    ".config",
    ".env",
    ".js",
    ".mjs",
    ".cjs",
    ".ts",
    ".tsx",
    ".jsx",
    ".css",
    ".scss",
    ".sass",
    ".less",
    ".html",
    ".xml",
    ".svg",
    ".sh",
    ".bash",
    ".zsh",
    ".fish",
    ".ps1",
    ".sql",
    ".csv",
    ".tsv",
    ".properties",
    ".lock",
    ".sample",
    ".service",
    ".cfg",
}

TEXT_FILENAMES = {
    ".gitignore",
    ".dockerignore",
    ".gitattributes",
}

CONTROL_MAP = {
    "\t": "    ",
}


def posix_rel(root: Path, path: Path) -> str:
    return path.relative_to(root).as_posix()


def is_probably_text(rel_path: str, sample: bytes) -> bool:
    suffix = Path(rel_path).suffix.lower()
    name = Path(rel_path).name.lower()
    if suffix in TEXT_EXTENSIONS or name in TEXT_FILENAMES:
        return True
    if b"\x00" in sample:
        return False
    if not sample:
        return True
    suspicious = 0
    for byte in sample:
        printable = (32 <= byte <= 126) or byte in (9, 10, 13) or byte >= 0x80
        if not printable:
            suspicious += 1
    return (suspicious / len(sample)) < 0.2


def sha256_hex(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def display_units(text: str) -> int:
    units = 0
    for ch in text:
        if unicodedata.east_asian_width(ch) in {"F", "W", "A"}:
            units += 2
        else:
            units += 1
    return units


def sanitize_for_pdf(text: str) -> str:
    out = []
    for ch in text:
        if ch in CONTROL_MAP:
            out.append(CONTROL_MAP[ch])
            continue
        if ord(ch) < 32 or ord(ch) == 127:
            out.append(f"\\x{ord(ch):02x}")
            continue
        out.append(ch)
    return "".join(out)


def wrap_display(text: str, max_units: int):
    text = sanitize_for_pdf(text)
    if text == "":
        return [""]
    lines = []
    current = []
    current_units = 0
    for ch in text:
        char_units = 2 if unicodedata.east_asian_width(ch) in {"F", "W", "A"} else 1
        if current and current_units + char_units > max_units:
            lines.append("".join(current))
            current = [ch]
            current_units = char_units
        else:
            current.append(ch)
            current_units += char_units
    if current:
        lines.append("".join(current))
    return lines


class PdfArchiveWriter:
    def __init__(self, output_path: Path, title: str, max_units: int, font_size: float, leading: float):
        self.output_path = output_path
        self.title = title
        self.max_units = max_units
        self.font_size = font_size
        self.leading = leading
        self.margin_x = 18
        self.margin_top = 20
        self.margin_bottom = 18
        self.page_size = landscape(A3)
        self.width, self.height = self.page_size
        self.font_name = "HeiseiKakuGo-W5"
        pdfmetrics.registerFont(UnicodeCIDFont(self.font_name))
        self.canvas = canvas.Canvas(str(output_path), pagesize=self.page_size, pageCompression=1)
        self.page_no = 1
        self._begin_page()

    def _begin_page(self):
        self.text = self.canvas.beginText()
        self.text.setTextOrigin(self.margin_x, self.height - self.margin_top)
        self.text.setFont(self.font_name, self.font_size)
        self.y = self.height - self.margin_top

    def _draw_footer(self):
        self.canvas.setFont(self.font_name, 7)
        self.canvas.drawString(self.margin_x, 8, self.title)
        self.canvas.drawRightString(self.width - self.margin_x, 8, f"Page {self.page_no}")

    def _flush_page(self, final: bool):
        self.canvas.drawText(self.text)
        self._draw_footer()
        if not final:
            self.canvas.showPage()

    def _ensure_space(self):
        if self.y - self.leading < self.margin_bottom:
            self._flush_page(final=False)
            self.page_no += 1
            self._begin_page()

    def write_line(self, line: str):
        segments = wrap_display(line, self.max_units)
        for segment in segments:
            self._ensure_space()
            self.text.textLine(segment)
            self.y -= self.leading

    def write_blank(self):
        self.write_line("")

    def close(self):
        self._flush_page(final=True)
        self.canvas.save()


def iter_base64_lines(data: bytes, width: int = 152):
    encoded = base64.b64encode(data).decode("ascii")
    for index in range(0, len(encoded), width):
        yield encoded[index:index + width]


def collect_files(root: Path, exclude_relative: set[str]):
    files = []
    unreadable = []
    for current_dir, dirnames, filenames in os.walk(root, topdown=True):
        dirnames.sort()
        filenames.sort()
        current_path = Path(current_dir)
        for filename in filenames:
            abs_path = current_path / filename
            try:
                if not abs_path.is_file():
                    continue
            except OSError as error:
                unreadable.append((posix_rel(root, abs_path), str(error)))
                continue
            rel = posix_rel(root, abs_path)
            if rel in exclude_relative or rel.startswith("deliverables/project_folder_full_contents_"):
                continue
            files.append(abs_path)
    files.sort(key=lambda item: posix_rel(root, item))
    return files, unreadable


def default_output_path(root: Path) -> Path:
    stamp = datetime.now().strftime("%Y%m%dT%H%M%S")
    return root / "deliverables" / f"project_folder_full_contents_{stamp}.pdf"


def main():
    parser = argparse.ArgumentParser(description="Export the full project folder contents into one PDF.")
    parser.add_argument("--output", type=Path, help="Output PDF path. Defaults to deliverables/project_folder_full_contents_<timestamp>.pdf")
    parser.add_argument("--max-units", type=int, default=210, help="Maximum display-width units per rendered line")
    parser.add_argument("--font-size", type=float, default=5.6, help="Base font size for the PDF")
    parser.add_argument("--leading", type=float, default=6.2, help="Line height for the PDF")
    parser.add_argument("--progress-every", type=int, default=50, help="Progress report interval")
    parser.add_argument("--file-limit", type=int, default=0, help="Optional file limit for testing")
    args = parser.parse_args()

    root = Path.cwd()
    output_path = (args.output if args.output else default_output_path(root)).resolve()
    output_path.parent.mkdir(parents=True, exist_ok=True)

    exclude_relative = {posix_rel(root, output_path)} if output_path.is_relative_to(root) else set()
    files, unreadable = collect_files(root, exclude_relative)

    if args.file_limit and args.file_limit > 0:
        files = files[: args.file_limit]

    temp_dir = Path(tempfile.mkdtemp(prefix="project-folder-pdf-"))
    temp_pdf = temp_dir / output_path.name

    writer = PdfArchiveWriter(
        output_path=temp_pdf,
        title="JPYC Project Folder Full Contents",
        max_units=args.max_units,
        font_size=args.font_size,
        leading=args.leading,
    )

    total_bytes = 0
    text_files = 0
    binary_files = 0

    writer.write_line("PROJECT FOLDER FULL CONTENTS PDF")
    writer.write_line(f"ROOT_PATH: {root}")
    writer.write_line(f"GENERATED_AT: {datetime.now().isoformat()}")
    writer.write_line("RULES:")
    writer.write_line("- Every file in the project folder is included except the output PDF itself and prior PDFs with the same prefix to avoid self-reference recursion.")
    writer.write_line("- Text-like files are rendered as raw UTF-8 text with replacement for undecodable bytes.")
    writer.write_line("- Binary files are rendered as exact-byte base64 blocks.")
    writer.write_line("- No file bodies are summarized.")
    writer.write_line(f"UNREADABLE_PATH_COUNT_AT_SCAN_START: {len(unreadable)}")
    writer.write_line(f"FILE_COUNT: {len(files)}")
    writer.write_blank()

    for index, abs_path in enumerate(files, start=1):
        rel = posix_rel(root, abs_path)
        try:
            data = abs_path.read_bytes()
        except OSError as error:
            unreadable.append((rel, str(error)))
            continue

        total_bytes += len(data)
        text_like = is_probably_text(rel, data[:4096])
        file_hash = sha256_hex(data)
        writer.write_line("=" * 120)
        writer.write_line(f"FILE_INDEX: {index}/{len(files)}")
        writer.write_line(f"PATH: {rel}")
        writer.write_line(f"SIZE_BYTES: {len(data)}")
        writer.write_line(f"SHA256: {file_hash}")
        writer.write_line(f"CONTENT_MODE: {'raw-text' if text_like else 'base64-exact-bytes'}")
        writer.write_line("BEGIN_CONTENT")

        if text_like:
            text_files += 1
            decoded = data.decode("utf-8", errors="replace")
            has_trailing_newline = decoded.endswith("\n") or decoded.endswith("\r")
            writer.write_line("TEXT_ENCODING_RENDER: utf-8-with-replacement")
            writer.write_line(f"TEXT_HAS_TRAILING_NEWLINE: {'yes' if has_trailing_newline else 'no'}")
            writer.write_line("---")
            for line in decoded.splitlines():
                writer.write_line(line)
            if decoded == "":
                writer.write_line("")
        else:
            binary_files += 1
            writer.write_line("BINARY_ENCODING_RENDER: base64")
            writer.write_line("---")
            for line in iter_base64_lines(data):
                writer.write_line(line)

        writer.write_line("END_CONTENT")
        writer.write_blank()

        if args.progress_every > 0 and (index % args.progress_every == 0 or index == len(files)):
            print(
                json.dumps(
                    {
                        "progress": index,
                        "total_files": len(files),
                        "current_path": rel,
                        "total_bytes_so_far": total_bytes,
                    },
                    ensure_ascii=False,
                ),
                flush=True,
            )

    if unreadable:
        writer.write_line("=" * 120)
        writer.write_line("UNREADABLE_PATHS")
        for rel, error in unreadable:
            writer.write_line(f"{rel}: {error}")

    writer.close()
    shutil.move(str(temp_pdf), str(output_path))
    shutil.rmtree(temp_dir, ignore_errors=True)

    summary = {
        "ok": True,
        "output_pdf": str(output_path),
        "file_count": len(files),
        "text_files": text_files,
        "binary_files": binary_files,
        "total_bytes": total_bytes,
        "page_count": writer.page_no,
        "pdf_size_bytes": output_path.stat().st_size,
        "unreadable_paths": len(unreadable),
    }
    print(json.dumps(summary, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
