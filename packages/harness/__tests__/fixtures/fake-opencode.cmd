@echo off
rem Windows shim for the fake opencode CLI used by harness / sessions e2e tests.
rem The harness's opencode-cli driver has Windows-specific shim unwrapping, so
rem we exercise that path by going through a .cmd wrapper rather than calling
rem node directly. %~dp0 is the directory holding this .cmd file.
node "%~dp0fake-opencode.cjs" %*
