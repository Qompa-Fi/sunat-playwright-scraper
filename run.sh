#!/bin/sh

nix develop --command sh -c "xvfb-run -a bun index.ts"
