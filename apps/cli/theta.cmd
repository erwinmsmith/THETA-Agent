@echo off
setlocal
node --disable-warning=ExperimentalWarning "%~dp0dist\cli.js" %*
