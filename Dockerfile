FROM node:22-slim
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --omit=optional --ignore-scripts
COPY . .
ENV OG_DESK_BIND=0.0.0.0 PORT=7879
USER node
EXPOSE 7879
CMD ["node", "bin/og-desk.js", "relay"]
