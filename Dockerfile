FROM node:22-slim
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --omit=optional --ignore-scripts
COPY . .
ENV MANY_DESKS_BIND=0.0.0.0 PORT=7879
USER node
EXPOSE 7879
CMD ["node", "bin/many-desks.js", "relay"]
