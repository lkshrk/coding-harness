set dotenv-load

toolchains := "python go node"

default:
    @just --list

# Build sandbox images (toolchain + OpenCode + DeepSeek Harness)
build toolchain="all":
    #!/usr/bin/env bash
    set -euo pipefail
    for t in {{ if toolchain == "all" { toolchains } else { toolchain } }}; do
        case $t in
            python) base=python:3.13-bookworm ;;
            go) base=golang:1.26-bookworm ;;
            node) base=node:24-bookworm ;;
        esac
        docker build -f docker/Dockerfile --build-arg BASE="$base" -t "coding-harness:$t" docker
    done

# Run one task under one experiment locally, e.g. `just run tuppr-single-node-drain B-qwen-coder`
run task experiment:
    uv run harness run {{ task }} {{ experiment }}

# Check benchmark tasks: hidden tests must fail on base and pass on the reference fix
validate *tasks:
    uv run harness validate {{ tasks }}

# Upload benchmark/ to Phoenix as a dataset
dataset name="coding-harness-benchmark":
    uv run harness dataset --name {{ name }}

# Run an experiment over the Phoenix dataset
experiment experiment dataset="coding-harness-benchmark":
    uv run harness experiment {{ experiment }} --dataset {{ dataset }}

# Print a run's summary
show run:
    jq 'del(.steps, .verifications)' runs/{{ run }}/result.json

# Delete all runs and leftover sandbox containers
reset:
    -docker ps -aq --filter name=harness- | xargs -r docker rm -f
    rm -rf runs

lint:
    uvx ruff check src
