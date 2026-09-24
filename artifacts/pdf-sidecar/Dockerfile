# PDF sidecar (FastAPI). Bundles poppler-utils so pdf2image works without any
# native install on the host — the whole point of running this in Docker on
# Windows. The Node API reaches it at PDF_SIDECAR_URL (default http://localhost:8008).
FROM python:3.11-slim

# poppler-utils provides pdftoppm/pdftocairo used by pdf2image for rasterization.
#
# Switch Debian's apt mirrors to HTTPS before updating: some networks (corporate
# VPN/proxy, certain Docker Desktop setups) block outbound port 80, which makes
# the default http:// mirrors fail `apt-get update` with "connection refused".
# Port 443 is already known-good here (the base image pulled over HTTPS). The
# python:slim image ships ca-certificates, so HTTPS apt works out of the box.
RUN set -eux; \
    for f in /etc/apt/sources.list /etc/apt/sources.list.d/debian.sources; do \
      if [ -f "$f" ]; then sed -i 's|http://|https://|g' "$f"; fi; \
    done; \
    apt-get update; \
    apt-get install -y --no-install-recommends poppler-utils; \
    rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt

COPY . .

ENV PORT=8008
EXPOSE 8008

CMD ["python", "main.py"]
