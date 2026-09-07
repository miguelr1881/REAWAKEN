# PDF.js

Pinned dependency: pdfjs-dist 4.10.38, Apache-2.0 (see LICENSE).
Source: https://registry.npmjs.org/pdfjs-dist/-/pdfjs-dist-4.10.38.tgz

Only build/pdf.mjs and its matching build/pdf.worker.mjs are installed.
Used for local text extraction, not PDF rendering or OCR. No document upload.
Both files must be published together and are cached by the service worker.