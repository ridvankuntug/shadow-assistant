# deploy

Deployment files for running Shadow Assistant at home.

`docker-compose.yml` is a placeholder. Service definitions (core, ui,
whisper-svc, tts-svc) will be added once those components have images.
Configuration comes from the root `.env` file (copy `.env.example`); never put
real tokens, hostnames or IP addresses in files tracked by git.
