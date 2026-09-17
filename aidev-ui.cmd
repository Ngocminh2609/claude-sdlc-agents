@echo off
REM Double-click launcher for the local web console on Windows.
REM
REM Keeps a console window open on purpose: it hosts the server, so closing
REM the window is how you stop the UI (and any run still in flight with it).
REM From a terminal, `aidev ui` does the same thing.

cd /d "%~dp0"
node "%~dp0bin\aidev.js" ui %*

if errorlevel 1 (
  echo.
  echo The aidev UI exited with an error. The message above says why.
  pause
)
