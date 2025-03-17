#!/bin/bash

# The commands I have used to deploy the script. They're unsorted.

gcloud compute --project="qompa-io" firewall-rules create allow-sunat-scraper-port \
    --source-tags="sunat-playwright-scraper" --allow="tcp:19877" --source-ranges="0.0.0.0/0" --description="Allow external access to the scraper port"

npm run build && gcloud compute --zone "us-east1-b" --project "qompa-io" scp --recurse \
    {./dist,./package.json,./bun.lockb} sunat-playwright-scraper:/home/luisnquin/app
(cd app && bun install)

sudo apt install -y unzip xvfb xauth
curl -fsSL https://bun.sh/install | bash

npx playwright install --with-deps chromium

cat <<EOF | sudo tee /etc/systemd/system/sunat-scraper.service
[Unit]
Description=SUNAT Playwright Scraper
After=network.target

[Service]
User=luisnquin
WorkingDirectory=/home/luisnquin/app
ExecStart=/usr/bin/xvfb-run -a bun dist/index.js
ExecStop=/usr/bin/rm -rf /tmp/playwright*
Restart=always
Environment=NODE_ENV=production
Environment=PATH=/home/luisnquin/.bun/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
RuntimeMaxSec=3m

[Install]
WantedBy=multi-user.target
EOF

sudo systemctl daemon-reload
sudo systemctl enable --now sunat-scraper
