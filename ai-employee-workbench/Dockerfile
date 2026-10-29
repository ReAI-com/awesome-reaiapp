ARG NODE_IMAGE=node:22
FROM ${NODE_IMAGE} AS build

WORKDIR /app
COPY package.json package-lock.json ./
# tsx is also the production TypeScript runner; keep dev dependencies installed.
RUN npm ci --include=dev --no-audit --no-fund
COPY . .
RUN npm run build

FROM ${NODE_IMAGE} AS runtime
WORKDIR /app
ENV NODE_ENV=production \
    EMPLOYEE_HOST=0.0.0.0 \
    PORT=4317 \
    EMPLOYEE_DATA_DIR=/app/.data

COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/package.json /app/package-lock.json ./
COPY --from=build /app/tsconfig.json ./
COPY --from=build /app/server ./server
COPY --from=build /app/shared ./shared
COPY --from=build /app/examples ./examples
COPY --from=build /app/dist ./dist
RUN mkdir -p /app/.data && chown 1000:1000 /app/.data && chmod 0700 /app/.data

USER 1000:1000
EXPOSE 4317
STOPSIGNAL SIGTERM
CMD ["node", "--import", "tsx", "server/index.ts", "--production"]
