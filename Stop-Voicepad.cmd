@echo off
cd /d "%~dp0"
python -c "from urllib.request import Request,urlopen; urlopen(Request('http://127.0.0.1:8768/api/quit',data=b'',method='POST'),timeout=3).read()"
