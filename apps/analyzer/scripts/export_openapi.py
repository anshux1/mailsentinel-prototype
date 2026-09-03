import json
import os
import sys
from pathlib import Path

os.environ.setdefault("DATABASE_URL", "postgresql://contract:contract@localhost:5432/contract")
os.environ.setdefault("S3_ACCESS_KEY_ID", "contract")
os.environ.setdefault("S3_SECRET_ACCESS_KEY", "contract-secret-value")
os.environ.setdefault("ANALYZER_SERVICE_TOKEN", "contract-service-token")
os.environ.setdefault("APP_ENV", "test")
sys.path.insert(0, str(Path(__file__).parents[1]))

from app.contracts.openapi import build_analyzer_openapi  # noqa: E402
from app.main import app  # noqa: E402

schema = build_analyzer_openapi(app)
Path("openapi.json").write_text(json.dumps(schema, indent=2, sort_keys=True) + "\n")
