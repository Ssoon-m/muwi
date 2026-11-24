@echo off
rem muwi command for Windows PowerShell and cmd. npm puts it on PATH; muwi setup also writes ~/.local/bin/muwi.cmd.
rem Runs src\cli.js (npm package) or src\cli.ts (repository) with Node 24 or later. Git Bash uses the extensionless bin/muwi script instead.
if exist "%~dp0..\src\cli.js" (node "%~dp0..\src\cli.js" %*) else (node "%~dp0..\src\cli.ts" %*)
exit /b %ERRORLEVEL%
