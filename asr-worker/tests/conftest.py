import os
import sys

# Tests import the worker modules (merge, schema, handler) by their flat names,
# exactly as the container does from /app.
sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))
