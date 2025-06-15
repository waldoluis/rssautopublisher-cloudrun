// index.js

const express = require('express');
const Parser = require('rss-parser');
const parser = new Parser();
const { VertexAI } = require('@google-cloud/vertexai');
const { SecretManagerServiceClient } = require('@google-cloud/secret-manager'); // Re-importado para credenciales de WordPress
const axios = require('axios'); // Re-importado para la API de WordPress

const app = express();
app.use(express.json());

// --- Configuración de Google Cloud ---
const project = process.env.GCP_PROJECT || 'zapzap-462322';
const location = 'us-central1';

// Inicialización del cliente de Vertex AI para Gemini
const vertex_ai = new VertexAI({ project, location });
const model = vertex_ai.getGenerativeModel({
  model: 'gemini-2.0-flash-001'
});

const generationConfig = {
  temperature: 0.7,
};

const secretManagerClient = new SecretManagerServiceClient(); // Inicializado para Secret Manager

// Función auxiliar para acceder a secretos de Secret Manager
async function accessSecretVersion(secretId, versionId = 'latest') {
    try {
        const name = `projects/${project}/secrets/${secretId}/versions/${versionId}`;
        const [version] = await secretManagerClient.accessSecretVersion({ name });
        return version.payload.data.toString('utf8');
    } catch (error) {
        console.error(`Error al acceder al secreto '${secretId}': ${error.message}`);
        throw new Error(`No se pudo acceder al secreto necesario: ${secretId}`);
    }
}

// Lista de RSS que analizarás (Proceso eliminado)
const rssFeeds = [
  'https://www.excelsior.com.mx/rss.xml',
  'https://elpais.com/rss/feed.html?feedId=1022',
  'https://www.eleconomista.com.mx/rss.html',
  'https://www.jornada.com.mx/v7.0/cgi/rss.php',
];

/**
 * Función para publicar una nota en WordPress.
 * Requiere la URL de la API de WordPress y el Application Password.
 */
async function publishToWordPress(title, content, link, socialMediaCopy, credentials) {
    const { wordpressApiUrl, wordpressApplicationPassword } = credentials;

    // Puedes elegir qué contenido enviar. Aquí envío la nota completa y el copy como contenido.
    // También puedes crear un post separado para el copy de redes, o incluirlo en la nota.
    // Para este ejemplo, la nota es el contenido principal y el copy de redes va al final.
    const postContent = `<p>${content}</p>
    <p><strong>Enlace original:</strong> <a href="${link}">${link}</a></p>
    <p><strong>Copy para Redes Sociales:</strong> ${socialMediaCopy}</p>
    `;


    const data = {
        title: title,
        content: postContent,
        status: 'publish', // O 'draft' para revisar antes de publicar
        // Puedes añadir más campos aquí, como categorías, etiquetas, etc.
        // Por ejemplo: categories: [1, 2], tags: [3, 4]
    };

    try {
        console.log(`Intentando publicar en WordPress: "${title}"`);
        const response = await axios.post(wordpressApiUrl, data, {
            headers: {
                'Content-Type': 'application/json',
                // La autenticación básica usa "usuario:ApplicationPassword" codificado en Base64
                'Authorization': `Basic ${Buffer.from(`tu_usuario_wordpress:${wordpressApplicationPassword}`).toString('base64')}`
            }
        });
        console.log(`[ÉXITO] Publicado en WordPress: "${title}". ID del post: ${response.data.id}`);
        return { status: 'success', postId: response.data.id, link: response.data.link };
    } catch (wpError) {
        console.error(`[ERROR] Fallo al publicar "${title}" en WordPress: ${wpError.message}`);
        if (wpError.response) {
            console.error(`Respuesta de error de WordPress: ${JSON.stringify(wpError.response.data)}`);
        }
        return { status: 'failed', error: wpError.message };
    }
}


/**
 * Función principal que ejecuta la lógica de lectura de RSS, generación de nota periodística y copy para redes, y publicación en WordPress.
 */
async function executeRssToWordPressFlow() {
  console.log('Inicio de la ejecución del flujo RSS a Nota Periodística, Copy para Redes y Publicación en WordPress.');
  let noticias = [];
  let wordpressCredentials;

  // --- Obtener credenciales de WordPress de Secret Manager ---
  try {
      const credsJson = await accessSecretVersion('wordpress-api-credentials');
      wordpressCredentials = JSON.parse(credsJson);
      // Validar que las credenciales tienen los campos esperados
      if (!wordpressCredentials.wordpressApiUrl || !wordpressCredentials.wordpressApplicationPassword || !wordpressCredentials.wordpressUsername) {
          throw new Error('Las credenciales de WordPress no están completas en Secret Manager.');
      }
      // Reemplaza 'tu_usuario_wordpress' en la autorización con el usuario real
      wordpressCredentials.authHeader = `Basic ${Buffer.from(`${wordpressCredentials.wordpressUsername}:${wordpressCredentials.wordpressApplicationPassword}`).toString('base64')}`;
      console.log('Credenciales de WordPress obtenidas con éxito.');
  } catch (error) {
      console.error(`[ERROR FATAL] No se pudieron obtener o parsear las credenciales de WordPress: ${error.message}`);
      return { success: false, message: 'Fallo al obtener las credenciales de WordPress.' };
  }


  // --- 1. Leer todos los feeds RSS y recopilar noticias ---
  console.log('Comenzando la lectura de feeds RSS...');
  for (const feedUrl of rssFeeds) {
    try {
      const feed = await parser.parseURL(feedUrl);
      console.log(`Feed '${feed.title}' (${feedUrl}) parseado. Encontrados ${feed.items.length} elementos.`);
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
  console.log(`Se seleccionaron ${noticiasParaProcesar.length} noticias para procesar.`);

  // --- 2. Generar notas periodísticas y copies para redes con Gemini y publicar ---
  const processingResults = [];
  if (noticiasParaProcesar.length === 0) {
      console.log('No hay noticias nuevas o seleccionadas para procesar.');
  }

  for (const noticia of noticiasParaProcesar) {
    console.log(`Procesando noticia: "${noticia.title}"`);

    let generatedArticle = '';
    let socialMediaCopy = '';
    let wordpressPublishResult = { status: 'skipped', message: 'No se intentó publicar.' };

    // --- PRIMERA LLAMADA A GEMINI: Generar Nota Periodística ---
    const newsArticlePrompt = `Basado en la siguiente noticia, escribe una nota periodística completa y detallada, con un estilo profesional y objetivo. Incluye:

1.  Un titular informativo y atractivo.
2.  Un lead (primer párrafo) que resuma lo más importante (qué, quién, cuándo, dónde, por qué).
3.  Desarrollo del cuerpo de la noticia con detalles adicionales, contexto, y si es posible, declaraciones o implicaciones (si la información lo permite).
4.  Cierre o conclusión.
5.  La nota debe tener una extensión adecuada para un artículo breve (aproximadamente 3-5 párrafos).

Título de la Noticia: "${noticia.title}"
Contenido/Extracto: "${noticia.contentSnippet}"
Enlace Original: ${noticia.link}`;

    const newsArticleRequest = {
      contents: [{ role: 'user', parts: [{ text: newsArticlePrompt }] }],
      generationConfig,
    };

    try {
      const newsArticleResult = await model.generateContent(newsArticleRequest);
      generatedArticle = newsArticleResult.response.candidates[0].content.parts[0].text;
      console.log(`Nota periodística generada para "${noticia.title}":\n${generatedArticle.substring(0, 200)}...`);
    } catch (geminiError) {
      console.error(`[ERROR] Fallo al generar nota periodística con Gemini para "${noticia.title}": ${geminiError.message}`);
      generatedArticle = `[ERROR AL GENERAR NOTA: ${geminiError.message}]`;
    }

    // --- SEGUNDA LLAMADA A GEMINI: Generar Copy para Redes Sociales (usando la nota generada) ---
    if (generatedArticle && !generatedArticle.startsWith('[ERROR AL GENERAR NOTA')) {
        const socialMediaCopyPrompt = `Crea un copy corto y atractivo para redes sociales (máximo 2 líneas, con 1-2 emojis) basado en la siguiente nota periodística. El objetivo es captar la atención y dirigir al lector a leer más. No incluyas hashtags ni menciones.

        Nota periodística:
        "${generatedArticle}"`;

        const socialMediaCopyRequest = {
            contents: [{ role: 'user', parts: [{ text: socialMediaCopyPrompt }] }],
            generationConfig,
        };

        try {
            const socialMediaCopyResult = await model.generateContent(socialMediaCopyRequest);
            socialMediaCopy = socialMediaCopyResult.response.candidates[0].content.parts[0].text;
            console.log(`Copy para redes generado para "${noticia.title}": ${socialMediaCopy}`);
        } catch (copyError) {
            console.error(`[ERROR] Fallo al generar copy para redes con Gemini para "${noticia.title}": ${copyError.message}`);
            socialMediaCopy = `[ERROR AL GENERAR COPY: ${copyError.message}]`;
        }
    } else {
        socialMediaCopy = '[NO SE GENERÓ COPY POR ERROR EN LA NOTA]';
    }

    // --- PUBLICAR EN WORDPRESS ---
    if (generatedArticle && !generatedArticle.startsWith('[ERROR AL GENERAR NOTA')) {
        wordpressPublishResult = await publishToWordPress(
            noticia.title,
            generatedArticle,
            noticia.link,
            socialMediaCopy,
            { // Pasamos solo las credenciales relevantes aquí para la función publishToWordPress
                wordpressApiUrl: wordpressCredentials.wordpressApiUrl,
                wordpressApplicationPassword: wordpressCredentials.wordpressApplicationPassword,
                wordpressUsername: wordpressCredentials.wordpressUsername // Aunque no se usa directamente en publishToWordPress, es bueno pasarlo para el authHeader
            }
        );
    } else {
        wordpressPublishResult = { status: 'skipped', message: 'No se intentó publicar en WordPress debido a un error en la generación de la nota.' };
    }


    processingResults.push({
      title: noticia.title,
      originalLink: noticia.link,
      source: noticia.source,
      newsArticle: generatedArticle,
      socialMediaCopy: socialMediaCopy,
      wordpressPublication: wordpressPublishResult // Resultado de la publicación en WP
    });
  }

  console.log('Finalizando la ejecución del flujo RSS a WordPress.');
  
  return {
    success: true,
    message: 'Análisis de RSS, generación de contenido y publicación en WordPress completados.',
    summary: {
        totalNewsFound: noticias.length,
        newsArticlesGenerated: processingResults.filter(r => !r.newsArticle.startsWith('[ERROR')).length,
        socialMediaCopiesGenerated: processingResults.filter(r => !r.socialMediaCopy.startsWith('[ERROR')).length,
        wordpressPostsPublished: processingResults.filter(r => r.wordpressPublication.status === 'success').length
    },
    generatedContentAndPublishResults: processingResults // Devolvemos todos los resultados
  };
}


// Definir una ruta HTTP para activar el flujo
app.post('/', async (req, res) => {
    try {
        const result = await executeRssToWordPressFlow();
        if (result.success) {
            res.status(200).json(result);
        } else {
            res.status(500).json(result); // Enviar error si el flujo no fue exitoso
        }
    } catch (error) {
        console.error(`[ERROR FATAL] Error en el endpoint de Cloud Run: ${error.message}`);
        res.status(500).send(`Error interno del servidor: ${error.message}`);
    }
});

// Cloud Run proporciona el puerto en la variable de entorno PORT
const PORT = parseInt(process.env.PORT) || 8080;
app.listen(PORT, () => {
  console.log(`La aplicación está escuchando en el puerto ${PORT}`);
});
