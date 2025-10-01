#!/bin/bash

# Install dependencies
pip install -r ForExemple/INFO_Agent/requirements.txt

# Start the Streamlit application
streamlit run ForExemple/INFO_Agent/app.py --server.port $PORT --server.headless true