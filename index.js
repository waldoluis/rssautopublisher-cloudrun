// index.js

const express = require('express'); // Necesario para iniciar un servidor HTTP en Cloud Run
const Parser = require('rss-parser');
const parser = new Parser();
const { VertexAI } = require('@google-cloud/vertexai');
const { SecretManagerServiceClient } = require('@google-cloud/secret-manager');
const axios = require('axios'); // Para hacer peticiones HTTP a la API de Facebook

const app = express();
app.use(express.json()); // Para parsear cuerpos JSON en caso de que el trigger sea un POST con body

// --- Configuración de Google Cloud ---
const project = process.env.GCP_PROJECT || 'zapzap-462322'; // Usa la variable de entorno o tu Project ID
const location = 'us-central1'; // Asegúrate de que esta sea la región donde está tu modelo Gemini

// Inicialización del cliente de Vertex AI para Gemini
const vertex_ai = new VertexAI({ project, location });
const model = vertex_ai.getGenerativeModel({
  model: 'gemini-2.0-flash-001' // Asegúrate de que este modelo esté disponible en tu región
});

const generationConfig = {
  temperature: 0.7,
};

const secretManagerClient = new SecretManagerServiceClient();

// Función auxiliar para acceder a secretos de Secret Manager
async function accessSecretVersion(secretId, versionId = 'latest') {
    try {
        const name = `projects/<span class="math-inline">\{project\}/secrets/</span>{secretId}/versions/${versionId}`;
        const [version] = await secretManagerClient.accessSecretVersion({ name });
        return version.payload.data.toString('utf8');
    } catch (error) {
        console.error(`Error al acceder al secreto '${secretId}': ${error.message}`);
        throw new Error(`No se pudo acceder al secreto necesario: ${secretId}`);
    }
}

// Lista de RSS que analizarás
const rssFeeds = [
  'https://www.excelsior.com.mx/rss.xml',
  'https://elpais.com/rss/feed.html?feedId=1022',
  'https://www.eleconomista.com.mx/rss.html',
  'https://www.jornada.com.mx/v7.0/cgi/rss.php',
  'https://www.proceso.com.mx/rss/', // Agregado: Proceso
];

/**
 * Función principal que ejecuta la lógica de lectura de RSS, generación de copy y publicación en Facebook.
 * Se envolverá en una ruta HTTP para Cloud Run.
 */
async function executeRssToFacebookFlow() {
  console.log('Inicio de la ejecución del flujo RSS a Facebook.');
  let noticias = [];

  // --- 1. Leer todos los feeds RSS y recopilar noticias ---
  console.log('Comenzando la lectura de feeds RSS...');
  for (const feedUrl of rssFeeds) {
    try {
      const feed = await parser.parseURL(feedUrl);
      console.log(`Feed '<span class="math-inline">\{feed\.title\}' \(</span>{feedUrl}) parseado. Encontrados ${feed.items.length} elementos.`);
      feed.items.forEach(item => {
        noticias.push({
          title: item.title,
          link: item.link,
          pubDate: item.pubDate,
          contentSnippet: item.contentSnippet || '',
          source: feed.title
        });
      });
    } catch (feedError) {
      console.warn(`[ADVERTENCIA] Error al procesar feed '${feedUrl}': ${feedError.message}`);
    }
  }

  noticias.sort((a, b) => new Date(b.pubDate) - new Date(a.pubDate));
  const noticiasParaProcesar = noticias.slice(0, 5); // Procesar las 5 noticias más recientes
  console.log(`Se seleccionaron ${noticiasParaProcesar.length} noticias para procesar con Gemini.`);

  // --- 2. Generar copies para cada noticia con Gemini ---
  const copiesGenerados = [];
  if (noticiasParaProcesar.length === 0) {
      console.log('No hay noticias nuevas o seleccionadas para generar copys.');
  }

  for (const noticia of noticiasParaProcesar) {
    console.log(`Generando copy para: "${noticia.title}"`);
    const prompt = `Redacta un copy atractivo para Facebook basado en la siguiente noticia. El estilo debe ser informativo y con tono periodístico, incluyendo:

1. Gancho o frase inicial llamativa.
2. Resumen claro en 1 o 2 frases.
3. Llamado a la acción para leer más.
4. Usa máximo 4 emojis.

No uses hashtags ni menciones. Máximo 4 líneas.

Título de la Noticia: "<span class="math-inline">\{noticia\.title\}"
Contenido/Extracto\: "</span>{noticia.contentSnippet}"
Enlace: ${noticia.link}`;

    const request = {
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      generationConfig,
    };

    try {
      const result = await model.generateContent(request);
      const generatedCopy = result.response.candidates[0].content.parts[0].text;
      console.log(`Copy generado para "${noticia.title}": ${generatedCopy}`);

      copiesGenerados.push({
        title: noticia.title,
        copy: generatedCopy,
        link: noticia.link,
        source: noticia.source
      });
    } catch (geminiError) {
      console.error(`[ERROR] Fallo al generar copy con Gemini para "${noticia.title}": ${geminiError.message}`);
    }
  }

  // --- 3. Publicar los copies generados en Facebook ---
  console.log('Comenzando la publicación en Facebook...');
  let FACEBOOK_PAGE_ACCESS_TOKEN;
  try {
      FACEBOOK_PAGE_ACCESS_TOKEN = await accessSecretVersion('facebook-page-access-token');
  } catch (error) {
      console.error(error.message); // El error ya se maneja en accessSecretVersion
      return { success: false, message: 'Fallo al acceder al token de Facebook.' };
  }

  const FACEBOOK_PAGE_ID = process.env.FACEBOOK_PAGE_ID; // Se obtiene de las variables de entorno

  if (!FACEBOOK_PAGE_ID) {
      console.error('[ERROR] La variable de entorno FACEBOOK_PAGE_ID no está configurada. No se publicará en Facebook.');
      return { success: false, message: 'Error de configuración: FACEBOOK_PAGE_ID no encontrado.' };
  }

  const facebookPublishResults = [];
  if (copiesGenerados.length === 0) {
      console.log('No hay copys generados para publicar en Facebook.');
  }

  for (const item of copiesGenerados) {
      const message = `${item.copy}\n\nLee más aquí: ${item.link}`;
      const facebookApiUrl = `https://graph.facebook.com/${FACEBOOK_PAGE_ID}/feed`;

      try {
          console.log(`Intentando publicar en Facebook: "${item.title}"`);
          const response = await axios.post(facebookApiUrl, null, {
              params: {
                  message: message,
                  link: item.link, // Esto ayuda a Facebook a generar la previsualización del enlace
                  access_token: FACEBOOK_PAGE_ACCESS_TOKEN
              }
          });
          console.log(`[ÉXITO] Publicado en Facebook: "${item.title}". ID del post: ${response.data.id}`);
          facebookPublishResults.push({
              title: item.title,
              status: 'success',
              facebookPostId: response.data.id,
              link: item.link
          });
      } catch (facebookError) {
          console.error(`[ERROR] Fallo al publicar "${item.title}" en Facebook: ${facebookError.message}`);
          if (facebookError.response) {
              console.error(`Respuesta de error de Facebook: ${JSON.stringify(facebookError.response.data)}`);
          }
          facebookPublishResults.push({
              title: item.title,
              status: 'failed',
              error: facebookError.message,
              link: item.link
          });
      }
  }

  console.log('Finalizando la ejecución del flujo RSS a Facebook.');
  return {
    success: true,
    message: 'Análisis de RSS, generación de copy y publicación en Facebook completados.',
    summary: {
        totalNewsFound: noticias.length,
        newsProcessedByGemini: copiesGenerados.length,
        newsPublishedToFacebook: facebookPublishResults.filter(r => r.status === 'success').length
    },
    processedNewsWithCopies: copiesGenerados,
    facebookPublishResults: facebookPublishResults
  };
}


// Definir una ruta HTTP para activar el flujo
app.post('/', async (req, res) => {
    try {
        const result = await executeRssToFacebookFlow();
        if (result.success) {
            res.status(200).json(result);
        } else {
            res.status(500).json(