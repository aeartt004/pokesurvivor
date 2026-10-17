/* ============ firebase-config.js — conexión con tu proyecto de Firebase ============
 * Pega aquí la configuración de tu app web de Firebase (Consola de Firebase >
 * Configuración del proyecto > Tus apps > SDK setup and configuration > Config).
 * Los pasos completos están en docs/FIREBASE.md.
 *
 * Estos datos NO son secretos: Firebase los diseña para ir en la web. Lo que
 * protege las partidas son las reglas de Firestore (firestore.rules).
 *
 * Si se pone a null, el juego funciona en modo local (sólo en el navegador).
 */
// Esta copia va en MODO LOCAL: la configuración de abajo es la del proyecto del
// autor original (pokesurvivor-free) y no se debe usar aquí (las partidas, el
// ranking y el cooperativo irían a su base de datos). Para tener nube propia,
// crea tu proyecto de Firebase (docs/FIREBASE.md) y pon aquí SU configuración.
// Con nube activa, el menú de trucos (js/ui/cheats-ui.js) no se abre.
G.FIREBASE_CONFIG = null;

/* Configuración original (proyecto pokesurvivor-free del autor, desde el 12-10-2026;
 * autenticación normal de Firebase, SIN Identity Platform):
G.FIREBASE_CONFIG = {
  apiKey: 'AIzaSyB1LpJcsnT7gj7c8cpRMGjhswLPr8-dnBw',
  authDomain: 'pokesurvivor-free.firebaseapp.com',
  projectId: 'pokesurvivor-free',
  storageBucket: 'pokesurvivor-free.firebasestorage.app',
  messagingSenderId: '798271504277',
  appId: '1:798271504277:web:dcac4409f969239e87009c',
  databaseURL: 'https://pokesurvivor-free-default-rtdb.europe-west1.firebasedatabase.app'
};
*/

/* Ejemplo de cómo debe quedar:
G.FIREBASE_CONFIG = {
  apiKey: 'AIza...',
  authDomain: 'tu-proyecto.firebaseapp.com',
  projectId: 'tu-proyecto',
  storageBucket: 'tu-proyecto.firebasestorage.app',
  messagingSenderId: '1234567890',
  appId: '1:1234567890:web:abc123'
};
*/
