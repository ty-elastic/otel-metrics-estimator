FROM python:3.12.6-slim-bookworm
RUN apt-get update && apt-get install -y curl git && rm -rf /var/lib/apt/lists/*

WORKDIR /python-docker

RUN git clone -b main --single-branch --depth 1 https://github.com/open-telemetry/opentelemetry-collector-contrib.git

COPY requirements.txt .
RUN --mount=type=cache,target=/root/.cache/pip pip3 install --root-user-action=ignore --upgrade -r requirements.txt

COPY frontend frontend
COPY otel_estimator.py .
COPY examples/config.yaml .

ENV PYTHONUNBUFFERED=1

EXPOSE 8080
CMD [ "python", "otel_estimator.py", "/python-docker/opentelemetry-collector-contrib", "--config", "config.yaml", "--host", "0.0.0.0"]