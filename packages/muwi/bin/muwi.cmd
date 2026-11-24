@echo off
rem muwi command for Windows PowerShell and cmd. Claude Code puts the plugin bin folder on PATH.
rem Runs src\cli.js (npm package) or src\cli.ts (repository) with Node 24 or later. Git Bash uses the extensionless bin/muwi script instead.
if exist "%~dp0..\src\cli.js" (node "%~dp0..\src\cli.js" %*) else (node "%~dp0..\src\cli.ts" %*)
exit /b %ERRORLEVEL%
