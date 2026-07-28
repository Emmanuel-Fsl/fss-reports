FROM python:3.11-slim

WORKDIR /app

# Install system deps needed by matplotlib
RUN apt-get update && apt-get install -y --no-install-recommends \
    libglib2.0-0 libsm6 libxext6 libxrender-dev \
    libcairo2-dev pkg-config \
    && rm -rf /var/lib/apt/lists/*

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY . .

EXPOSE 8080
CMD ["hypercorn", "--bind", "0.0.0.0:8080", "--workers", "1", "main:app"]
