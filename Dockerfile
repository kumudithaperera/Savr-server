# Build stage — installs all deps (incl. TypeScript) and compiles to dist/
FROM node:22-alpine AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build

# Runtime stage — production deps only + compiled output
FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY package*.json ./
RUN npm ci --omit=dev
COPY --from=build /app/dist ./dist
# Render provides PORT at runtime; the server reads process.env.PORT and binds 0.0.0.0
CMD ["npm", "start"]
