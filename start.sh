#!/bin/bash
echo "Starting Project VIPER site on port ${APP_PORT:-3000}..."
cd "$(dirname "$0")"
python3 -m http.server "${APP_PORT:-3000}"
