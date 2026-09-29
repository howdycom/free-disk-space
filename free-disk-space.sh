#!/usr/bin/env bash
# Reclaim disk on a GitHub-hosted Ubuntu runner. No arguments. No environment
# variables. Paths below are the preinstalled toolchains documented in README.md.
set -eo pipefail

echo "Disk before cleanup:"
df -h /
sudo rm -rf \
  /opt/ghc \
  /opt/hostedtoolcache \
  /usr/local/.ghcup \
  /usr/local/lib/android \
  /usr/local/share/boost \
  /usr/share/dotnet \
  /usr/share/swift
sudo docker image prune --all --force || true
sudo docker builder prune --all --force || true
echo "Disk after cleanup:"
df -h /
