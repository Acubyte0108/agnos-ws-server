# Use official node LTS
FROM node:20-alpine

# Create app directory
WORKDIR /usr/src/app

# Install dependencies first (cache)
COPY package*.json ./
RUN npm ci --production

# Copy source
COPY . .

# Expose port (Railway sets the port via env)
EXPOSE 4000

# Use non-root user (optional)
RUN addgroup -S appgroup && adduser -S appuser -G appgroup
USER appuser

# Start
CMD ["node", "server.js"]