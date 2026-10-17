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
// VERSIÓN NO OFICIAL (fork de aeartt004): proyecto de Firebase PROPIO,
// pokesurvivor-aeartt, separado del oficial. Las cuentas, partidas, ranking y
// cooperativo de esta versión NO se mezclan con los de pokesurvivor.com.
// No poner aquí nunca la configuración del proyecto del autor original.
G.FIREBASE_CONFIG = {
  apiKey: 'AIzaSyCoy3S9nmWsaf7KkaU6hlsBemdV42lruDc',
  authDomain: 'pokesurvivor-aeartt.firebaseapp.com',
  projectId: 'pokesurvivor-aeartt',
  storageBucket: 'pokesurvivor-aeartt.firebasestorage.app',
  messagingSenderId: '659935904455',
  appId: '1:659935904455:web:f11a158ddba88328d5b4e2',
  databaseURL: 'https://pokesurvivor-aeartt-default-rtdb.asia-southeast1.firebasedatabase.app'
};