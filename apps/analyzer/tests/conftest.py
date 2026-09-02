import os

os.environ["APP_ENV"] = "test"
os.environ.setdefault("DATABASE_URL", "postgresql://mailsentinel:mailsentinel@localhost:5432/mailsentinel")
os.environ.setdefault("S3_ACCESS_KEY_ID", "mailsentinel")
os.environ.setdefault("S3_SECRET_ACCESS_KEY", "mailsentinel-secret")
os.environ.setdefault("ANALYZER_SERVICE_TOKEN", "test-analyzer-token-change-me")
