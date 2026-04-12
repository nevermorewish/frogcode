---
name: docker-management
description: Manage Docker containers, images, volumes, networks, and Compose stacks - lifecycle ops, debugging, cleanup, and Dockerfile optimization.
version: 1.0.0
author: hermes-CCC (ported from Hermes Agent by NousResearch)
license: MIT
metadata:
  hermes:
    tags: [Docker, DevOps, Containers, Infrastructure, Compose]
    related_skills: []
---

# Docker Management

## Purpose

- Use this skill to run, inspect, debug, and clean up Docker workloads.
- Prefer it when the task involves containers, images, networks, volumes, or Compose stacks.
- This skill covers both day-to-day lifecycle operations and practical debugging patterns.

## Core Mental Model

- Images are immutable build artifacts.
- Containers are running or stopped instances of images.
- Volumes persist data outside the container filesystem lifecycle.
- Networks define service-to-service connectivity.
- Compose describes multi-container applications declaratively.

## Container Lifecycle

- Create and run a container.
- Start a stopped container.
- Stop a running container.
- Restart a container after config or dependency issues.
- Remove a container when it is no longer needed.

## Common Lifecycle Commands

```bash
docker run -d --name myapp -p 8080:80 -v ./data:/data myimage
docker start myapp
docker stop myapp
docker restart myapp
docker rm myapp
```

- `-d` runs the container in detached mode.
- `--name` assigns a stable container name.
- `-p 8080:80` maps host port `8080` to container port `80`.
- `-v ./data:/data` mounts a host path into the container.

## Run Command Pattern

```bash
docker run -d --name myapp -p 8080:80 -v ./data:/data myimage
```

Use this pattern when you need:

- background execution
- a predictable container name
- host-to-container port mapping
- local bind-mount persistence

## Inspect Running Containers

```bash
docker ps
docker ps -a
```

- `docker ps` shows running containers only.
- `docker ps -a` shows all containers including exited ones.
- Exited containers often reveal crash-loop or entrypoint problems.

## Exec Into a Container

```bash
docker exec -it myapp bash
```

- Use this when the container image includes `bash`.
- Fall back to `sh` for slimmer images:

```bash
docker exec -it myapp sh
```

Useful checks inside a container:

- verify file paths
- inspect environment variables
- test network reachability
- check permissions
- run the application command manually

## View Logs

```bash
docker logs -f myapp
```

- Use `-f` to follow logs live.
- Add `--tail 100` to reduce noise when the log is very large.
- Container logs are the fastest first stop for boot failures.

## List Images, Volumes, and Networks

```bash
docker images
docker volume ls
docker network ls
```

- `docker images` helps identify build tags and old layers.
- `docker volume ls` helps track stateful storage.
- `docker network ls` is useful when debugging Compose service communication.

## Build Images

```bash
docker build -t myapp:latest .
```

- Tag images explicitly.
- Rebuild after Dockerfile changes, dependency changes, or copy-step changes.
- Keep the build context small with a `.dockerignore`.

## Dockerfile Baseline

```dockerfile
FROM python:3.12-slim

WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY . .
CMD ["python", "app.py"]
```

- Copy dependency manifests before source code to improve layer caching.
- Use a narrow base image unless native toolchains are required.

## Multi-Stage Dockerfile Pattern

```dockerfile
FROM node:22 AS build
WORKDIR /src
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build

FROM nginx:alpine
COPY --from=build /src/dist /usr/share/nginx/html
HEALTHCHECK CMD wget -qO- http://localhost/ || exit 1
```

- Build dependencies stay in the builder stage.
- The final stage is smaller and carries less attack surface.
- Multi-stage builds are standard for frontend artifacts, Go binaries, and compiled assets.

## Health Checks

- Define health checks in the Dockerfile when the service has a meaningful liveness probe.
- Health checks help Compose and orchestration layers reason about readiness.

Example:

```dockerfile
HEALTHCHECK --interval=30s --timeout=5s --retries=3 CMD curl -fsS http://localhost:8080/health || exit 1
```

- Prefer an explicit application health endpoint.
- Avoid health checks that pass before dependencies are ready unless that is intentional.

## Docker Compose Basics

```bash
docker compose up -d
docker compose logs
docker compose down
```

- `docker compose up -d` starts the stack in the background.
- `docker compose logs` shows service logs across the stack.
- `docker compose down` stops and removes the stack's containers and network.

## Minimal Compose Example

```yaml
services:
  app:
    build: .
    ports:
      - "8080:8080"
    environment:
      APP_ENV: development
    depends_on:
      - redis

  redis:
    image: redis:7-alpine
```

- Compose is the default choice for local multi-service development.
- Keep service names stable because they also become DNS names on the Compose network.

## Inspect Container Metadata

```bash
docker inspect myapp | jq '.[0].NetworkSettings'
```

- Use `docker inspect` to view full JSON metadata.
- Pipe through `jq` to isolate fields that matter.
- Useful fields include mounts, networks, exposed ports, health status, and entrypoint configuration.

## Resource Usage

```bash
docker stats
```

- This gives a live view of CPU, memory, network I/O, and block I/O.
- Use it to spot memory leaks, unexpected idle CPU, or runaway workers.

## Copy Files In and Out

```bash
docker cp file.txt myapp:/app/
docker cp myapp:/app/output.log ./output.log
```

- `docker cp` is useful for hot inspection, artifact extraction, and ad hoc debugging.
- Prefer rebuilds for durable fixes, but `docker cp` can unblock investigation quickly.

## Cleanup

```bash
docker system prune -af
docker volume prune
```

- `docker system prune -af` removes unused containers, networks, dangling images, and build cache aggressively.
- `docker volume prune` removes unused volumes.
- Be careful: pruning can destroy useful cached layers and orphaned but still valuable data.

## Common Debugging Patterns

### Override the Entrypoint

```bash
docker run --rm -it --entrypoint sh myimage
```

- Override the entrypoint when the default startup command exits too quickly.
- This lets you inspect the filesystem and run the target process manually.

### Check Environment Variables

```bash
docker exec -it myapp env
```

- Verify that expected secrets, ports, and mode flags are actually present.
- Many container bugs reduce to missing or misspelled env vars.

### Check the Effective Command

```bash
docker inspect myapp | jq '.[0].Config.Entrypoint, .[0].Config.Cmd'
```

- This helps distinguish build-time assumptions from runtime reality.
- It is especially useful when wrapper scripts are involved.

### Verify Mounts

```bash
docker inspect myapp | jq '.[0].Mounts'
```

- Bind-mount mistakes are common in local development.
- Check source path, destination path, and access mode.

### Test Networking

```bash
docker exec -it myapp sh -c "wget -qO- http://redis:6379 || true"
```

- Test container-to-container DNS and reachability from inside the network namespace.
- For HTTP services, use `curl` or `wget`.
- For TCP-only services, use the relevant client or a port probe.

## Image Hygiene

- Pin important base images when reproducibility matters.
- Use slim runtime images where possible.
- Minimize package-manager caches and temporary files.
- Copy only what is needed.
- Keep secrets out of the image entirely.

## Security and Reliability Notes

- Do not bake credentials into Dockerfiles.
- Avoid running as root when the workload does not require it.
- Use read-only filesystems or dropped capabilities where appropriate.
- Scan images regularly with vulnerability tools.

## Operational Guidance

- Prefer Compose for local stacks rather than long hand-written `docker run` chains.
- Use `docker logs -f` first when a service does not start cleanly.
- Use `docker inspect` when port mappings or mounts behave unexpectedly.
- Use health checks for services that depend on internal readiness.
- Prune deliberately, not reflexively.

## Summary

- Manage container lifecycle with `run`, `start`, `stop`, `restart`, and `rm`.
- Build images with `docker build -t myapp:latest .`.
- Debug with `docker exec -it myapp bash`, `docker logs -f myapp`, `docker inspect`, and `docker stats`.
- Operate stacks with `docker compose up -d`, `docker compose logs`, and `docker compose down`.
- Clean carefully with `docker system prune -af` and `docker volume prune`.
- Use multi-stage Dockerfiles and health checks to improve runtime quality and image hygiene.
