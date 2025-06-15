# Dockerfile

# Usa una imagen base de Node.js
FROM node:20-slim

# Crea y establece el directorio de trabajo dentro del contenedor
WORKDIR /app

# Copia los archivos de package.json y package-lock.json (si existe)
COPY package*.json ./

# Instala las dependencias del proyecto
RUN npm install --production

# Copia el resto del código de la aplicación
COPY . .

# Expone el puerto en el que la aplicación escuchará (Cloud Run usa la variable de entorno PORT)
ENV PORT 8080
EXPOSE ${PORT}

# Define el comando para iniciar la aplicación cuando el contenedor se ejecute
CMD ["npm", "start"]