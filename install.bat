@echo off
echo Installing rb AI Assistant extension...
jupyter nbextension install nbextension --user --overwrite --destination=rb_extension
jupyter nbextension enable rb_extension/main --user
echo Done. Refresh Jupyter to see the robot button.
pause
