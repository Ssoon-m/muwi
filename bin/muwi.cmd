@echo off
rem muwi command for Windows PowerShell and cmd. Claude Code puts the plugin bin folder on PATH.
rem Runs src\cli.ts with Node 24 or later. Git Bash uses the extensionless bin/muwi script instead.
node "%~dp0..\src\cli.ts" %*
exit /b %ERRORLEVEL%
