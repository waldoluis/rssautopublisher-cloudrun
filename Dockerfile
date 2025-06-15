# Usa una imagen base oficial de Node.js
FROM node:20-slim

# Establece el directorio de trabajo en /app
WORKDIR /app

# Copia los archivos package.json y package-lock.json
# Esto permite que Docker use el caché de la capa de npm install
COPY package*.json ./

# Instala las dependencias de producción
RUN npm install --production

# Copia el resto del código de la aplicación
COPY . .

# Expone el puerto que la aplicación escuchará
EXPOSE 8080

# Define el comando para ejecutar la aplicación
CMD ["node", "index.js"]
