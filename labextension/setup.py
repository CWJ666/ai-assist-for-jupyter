from setuptools import setup, find_packages

setup(
    name="rb-assistant-lab",
    version="0.1.0",
    packages=find_packages(),
    package_data={"rb_assistant_lab": ["labextension/**"]},
)
