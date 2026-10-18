<!--
     __                      __  ___
    / /   ____  ____  ____ _/  |/  /__  ____ ___  ____  _______  __
   / /   / __ \/ __ \/ __ `/ /|_/ / _ \/ __ `__ \/ __ \/ ___/ / / /
  / /___/ /_/ / / / / /_/ / /  / /  __/ / / / / / /_/ / /  / /_/ /
 /_____/\____/_/ /_/\__, /_/  /_/\___/_/ /_/ /_/\____/_/   \__, /
                    /____/                                 /_____/

 cavira oss (c) 2026  -  nullure (c) 2026
 ==========================================================
 file  : deployments/README.md
 usage : implements the LongMemory README component
-->

# Optional cloud deployment examples

Local CLI, MCP, Windows startup, Docker and Compose work from the repository
root without these files. These examples are retained for optional hosting;
they are not automatically deployed or included in the npm package.

Run each platform from the repository root so the Dockerfile, package files
and dashboard paths resolve correctly. Where the platform requires a root
configuration, copy only the selected example into your deployment checkout:

| Platform | Example | Expected location when enabled |
| --- | --- | --- |
| Heroku | `heroku/app.json`, `heroku/heroku.yml` | Root `app.json` and `heroku.yml` |
| Railway | `railway/railway.json` | Root `railway.json` or the platform's explicit config path |
| Render | `render/render.yaml` | Root `render.yaml` or a configured Blueprint path |
| Vercel dashboard | `vercel/vercel.json` | Root `vercel.json` |
| DigitalOcean | `digitalocean/spec.yaml` | An explicitly supplied App Spec, or `.do/spec.yaml` |

Review the repository URL, persistent volume, API key, origins and TLS for the
chosen host. Vercel serves the dashboard and needs a separate LongMemory API.
Heroku's example does not provision persistent storage; adapt it before storing
durable memory. These templates are not evidence of a tested cloud deployment.
