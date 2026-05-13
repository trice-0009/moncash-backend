const express = require('express');
const axios = require('axios');
const cors = require('cors');
const path = require('path');
const https = require('https');

const app = express();

// ─────────────────────────────────────────────
//  CORS — autorise les appels depuis l'APK Android
// ─────────────────────────────────────────────
app.use(cors({
    origin: '*',  // Restreindre à votre domaine en prod si besoin
    methods: ['GET', 'POST'],
    allowedHeaders: ['Content-Type', 'Authorization']
}));
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ─────────────────────────────────────────────
//  FIREBASE ADMIN — initialisation sécurisée
// ─────────────────────────────────────────────
const admin = require('firebase-admin');
let db = null;
try {
    const serviceAccount = require('./service-account.json');
    admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
    db = admin.firestore();
    console.log("✅ Firebase Admin initialisé avec succès.");
} catch (e) {
    console.error("❌ ERREUR CRITIQUE Firebase Admin (Firestore désactivé) :", e.message);
}

// ─────────────────────────────────────────────
//  CONFIGURATION MONCASH
// ─────────────────────────────────────────────
const CLIENT_ID     = (process.env.MONCASH_CLIENT_ID     || "").trim();
const CLIENT_SECRET = (process.env.MONCASH_CLIENT_SECRET || "").trim();
const MONCASH_MODE  = (process.env.MONCASH_MODE          || "sandbox").toLowerCase();

const IS_PRODUCTION = MONCASH_MODE === "live" || MONCASH_MODE === "production";

const BASE_DOMAIN = IS_PRODUCTION
    ? "https://moncashbutton.digicelgroup.com/Api"
    : "https://sandbox.moncashbutton.digicelgroup.com/Api";

const BASE_URL_REDIRECT = IS_PRODUCTION
    ? "https://moncashbutton.digicelgroup.com/Moncash-middleware"
    : "https://sandbox.moncashbutton.digicelgroup.com/Moncash-middleware";

// URL de ce serveur (utilisée pour la vérification auto depuis /successs)
const SERVER_URL = (process.env.RENDER_EXTERNAL_URL || "https://moncash-backend-5ez9.onrender.com").trim();

if (!CLIENT_ID || !CLIENT_SECRET) {
    console.error("❌ ERREUR CRITIQUE : MONCASH_CLIENT_ID ou MONCASH_CLIENT_SECRET manquant !");
} else {
    console.log(`ℹ️  Mode MonCash : ${MONCASH_MODE.toUpperCase()}`);
    console.log(`ℹ️  CLIENT_ID   : ${CLIENT_ID.substring(0, 5)}...`);
}

// ─────────────────────────────────────────────
//  HELPER — Obtenir un access token OAuth
// ─────────────────────────────────────────────
async function getAccessToken() {
    const authString = Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString('base64');
    // URLSearchParams remplace querystring (déprécié depuis Node 16)
    const data = new URLSearchParams({ grant_type: 'client_credentials', scope: 'read,write' }).toString();

    console.log(`🔑 Obtention token OAuth → ${BASE_DOMAIN}/oauth/token`);
    const response = await axios.post(`${BASE_DOMAIN}/oauth/token`, data, {
        headers: {
            'Authorization': `Basic ${authString}`,
            'Content-Type': 'application/x-www-form-urlencoded',
            'User-Agent': 'MonCash-Node-Client/2.0'
        },
        timeout: 90000
    });
    console.log(`✅ Token obtenu (longueur: ${response.data.access_token?.length || 0})`);
    return response.data.access_token;
}

// ─────────────────────────────────────────────
//  HELPER — Vérifier + Mettre à jour Firestore
//  Centralisé pour être réutilisé par /verifypayment et /successs
// ─────────────────────────────────────────────
async function verifyAndUpdateFirestore(cleanOrderId) {
    if (!db) {
        console.warn("⚠️  Firestore désactivé — vérification ignorée.");
        return { verified: false, reason: "Firestore non disponible" };
    }

    const accessToken = await getAccessToken();

    // Tentative 1 : RetrieveOrderPayment (Recherche par orderId)
    let verifyResponse;
    try {
        verifyResponse = await axios.post(
            `${BASE_DOMAIN}/v1/RetrieveOrderPayment`,
            { orderId: cleanOrderId },
            {
                headers: { 'Authorization': `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
                timeout: 60000
            }
        );
    } catch (e) {
        // En cas d'échec de la première requête (parfois v1 vs V1)
        console.warn(`⚠️  Echec RetrieveOrderPayment, tentative V1...`, e.message);
        verifyResponse = await axios.post(
            `${BASE_DOMAIN}/V1/RetrieveOrderPayment`,
            { orderId: cleanOrderId },
            {
                headers: { 'Authorization': `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
                timeout: 60000
            }
        );
    }

    const paymentData = verifyResponse.data.payment || verifyResponse.data;
    const status = (paymentData.message || "inconnu").toUpperCase();
    const transactionId = paymentData.transaction_id || null;

    console.log(`📋 Statut paiement pour orderId ${cleanOrderId} : ${status}`);

    if (status !== "SUCCESSFUL") {
        return { verified: false, status, transactionId };
    }

    // ── Récupérer le pending_payment pour connaître userId et packName ──
    const pendingRef = db.collection('pending_payments').doc(cleanOrderId);
    const pendingDoc = await pendingRef.get();

    if (!pendingDoc.exists) {
        console.warn(`⚠️  Aucun pending_payment trouvé pour orderId: ${cleanOrderId}`);
        return { verified: true, status, transactionId, reason: "pending_payment introuvable" };
    }

    const { userId, packName, status: currentStatus } = pendingDoc.data();

    // ── Idempotence : ne pas traiter deux fois le même paiement ──
    if (currentStatus === 'paid' || currentStatus === 'completed') {
        console.log(`ℹ️  Paiement ${cleanOrderId} déjà traité — ignoré.`);
        return { verified: true, status, transactionId, alreadyProcessed: true };
    }

    if (!userId) {
        console.error(`❌ userId absent dans pending_payment pour orderId: ${cleanOrderId}`);
        return { verified: true, status, transactionId, reason: "userId absent" };
    }

    // ── Écriture Firestore : chaque transaction = nouveau document unique ──
    const batch = db.batch();
    const userRef = db.collection('users').doc(userId);

    // 1. Mise à jour du profil utilisateur (merge = ne jamais écraser)
    batch.set(userRef, {
        isPremium: true,
        lastPurchaseDate: admin.firestore.FieldValue.serverTimestamp(),
        lastTransactionId: transactionId
    }, { merge: true });

    // 2. Débloquer pack utilisateur
    if (packName) {
        batch.update(userRef, {
            ownedPacks: admin.firestore.FieldValue.arrayUnion(packName)
        });
        console.log(`🔥 Pack "${packName}" ajouté dans ownedPacks de ${userId}`);
    } else {
        console.warn(`⚠️  packName absent pour orderId ${cleanOrderId}`);
    }

    // 3. Sous-collection purchases — ID auto-généré = NOUVEAU document à chaque achat
    //    (même pack acheté 2x → 2 documents distincts)
    const purchaseRef = userRef.collection('purchases').doc(); // doc() sans ID = auto-ID
    batch.set(purchaseRef, {
        packName:        packName || null,
        amount:          pendingDoc.data().amount || null,
        transactionId:   transactionId,
        orderId:         cleanOrderId,
        originalOrderId: pendingDoc.data().originalOrderId || cleanOrderId,
        purchasedAt:     admin.firestore.FieldValue.serverTimestamp()
    });

    // 4. Collection globale "transactions" — historique complet toutes opérations
    //    ID auto-généré = chaque transaction est un nouveau document
    const txRef = db.collection('transactions').doc(); // doc() sans ID = auto-ID
    batch.set(txRef, {
        userId,
        packName:        packName || null,
        amount:          pendingDoc.data().amount || null,
        transactionId:   transactionId,
        orderId:         cleanOrderId,
        originalOrderId: pendingDoc.data().originalOrderId || cleanOrderId,
        status:          'paid',
        createdAt:       admin.firestore.FieldValue.serverTimestamp()
    });

    // 5. Marquer paiement comme validé
    batch.update(pendingRef, {
        status:      'paid',
        processedAt: admin.firestore.FieldValue.serverTimestamp(),
        transactionId
    });

    await batch.commit();
    console.log(`✅ Transaction enregistrée | purchaseId: ${purchaseRef.id} | txId: ${txRef.id}`);

    return { verified: true, status, transactionId, userId, packName, alreadyProcessed: false };
}

// ─────────────────────────────────────────────
//  HEALTH CHECK
// ─────────────────────────────────────────────
app.get('/health', (req, res) => {
    res.json({
        status: 'ok',
        mode: MONCASH_MODE.toUpperCase(),
        firebase: db ? 'connected' : 'disabled',
        timestamp: new Date().toISOString()
    });
});

// ─────────────────────────────────────────────
//  POST /createpayment
//  Corps attendu : { amount, orderId, userId, packName }
//  BUG FIX #2 : packName maintenant accepté et sauvegardé
// ─────────────────────────────────────────────
app.post('/createpayment', async (req, res) => {
    try {
        const { amount, orderId, userId, packName } = req.body;

        if (!amount || !orderId) {
            return res.status(400).json({ error: "Champs 'amount' et 'orderId' requis." });
        }
        if (!userId) {
            return res.status(400).json({ error: "Champ 'userId' requis pour lier le paiement à l'utilisateur." });
        }

        // Plus de parsing de string QUIZ_xxx
        const cleanOrderId = orderId.toString();

        console.log(`💳 Création paiement | amount: ${amount} HTG | orderId: ${cleanOrderId} | userId: ${userId} | pack: ${packName || 'N/A'}`);

        // Sauvegarder la trace complète AVANT d'appeler MonCash
        if (db) {
            try {
                await db.collection('pending_payments').doc(cleanOrderId).set({
                    userId,
                    packName: packName || null,   // BUG FIX #2 : packName sauvegardé
                    amount: parseFloat(amount),
                    status: 'pending',
                    originalOrderId: orderId,
                    createdAt: admin.firestore.FieldValue.serverTimestamp()
                });
                console.log(`📝 pending_payment enregistré (orderId: ${cleanOrderId})`);
            } catch (e) {
                console.error("⚠️  Erreur sauvegarde pending_payment:", e.message);
                // Non-bloquant : on continue quand même
            }
        }

        const accessToken = await getAccessToken();
        const startTime = Date.now();

        const paymentResponse = await axios.post(
            `${BASE_DOMAIN}/v1/CreatePayment`,
            { amount: parseFloat(amount), orderId: cleanOrderId },
            {
                headers: {
                    'Authorization': `Bearer ${accessToken}`,
                    'Content-Type': 'application/json',
                    'Accept': 'application/json',
                    'User-Agent': 'MonCash-Node-Client/2.0'
                },
                timeout: 180000
            }
        );

        const duration = ((Date.now() - startTime) / 1000).toFixed(2);
        console.log(`✅ CreatePayment répondu en ${duration}s`);

        // Extraction robuste du token de paiement
        const pToken = paymentResponse.data.payment_token;
        const tokenString = (typeof pToken === 'object') ? pToken.token : pToken;

        const redirectUrl = `${BASE_URL_REDIRECT}/Payment/Redirect?token=${tokenString}`;

        return res.status(200).json({
            success: true,
            redirect_url: redirectUrl,
            payment_token: tokenString,
            orderId: cleanOrderId  // Renvoyer l'orderId nettoyé à l'APK pour vérification ultérieure
        });

    } catch (error) {
        const details = error.response?.data || error.message;
        console.error("❌ Erreur /createpayment:", JSON.stringify(details));
        return res.status(500).json({ error: "Erreur MonCash lors de la création du paiement.", details });
    }
});

// ─────────────────────────────────────────────
//  GET /verifypayment?orderId=xxx
//  Accepte aussi les orderId complexes (ex: "QUIZ_cmpzR_Math_1778545562103")
// ─────────────────────────────────────────────
app.get('/verifypayment', async (req, res) => {
    try {
        const { orderId } = req.query;
        if (!orderId) return res.status(400).json({ error: "'orderId' manquant dans les paramètres." });

        // Plus de parsing de string QUIZ_xxx
        const cleanOrderId = orderId.toString();

        console.log(`🔍 /verifypayment | orderId: "${cleanOrderId}"`);
        const result = await verifyAndUpdateFirestore(cleanOrderId);

        return res.status(200).json({ success: true, ...result });

    } catch (error) {
        const details = error.response?.data || error.message;
        console.error("❌ Erreur /verifypayment:", JSON.stringify(details));
        return res.status(500).json({ error: "Erreur lors de la vérification du paiement.", details });
    }
});

// ─────────────────────────────────────────────
//  GET /verifybypending?originalOrderId=xxx
//  Permet à l'APK de vérifier avec son orderId
// ─────────────────────────────────────────────
app.get('/verifybypending', async (req, res) => {
    try {
        const { originalOrderId, userId } = req.query;
        if (!originalOrderId) return res.status(400).json({ error: "'originalOrderId' manquant." });
        if (!db) return res.status(503).json({ error: "Firestore non disponible." });

        // Plus de parsing de string QUIZ_xxx
        const cleanOrderId = originalOrderId.toString();

        console.log(`🔍 /verifybypending | orderId: "${cleanOrderId}"`);
        const result = await verifyAndUpdateFirestore(cleanOrderId);
        return res.status(200).json({ success: true, ...result });

    } catch (error) {
        const details = error.response?.data || error.message;
        console.error("❌ Erreur /verifybypending:", JSON.stringify(details));
        return res.status(500).json({ error: "Erreur vérification.", details });
    }
});

// ─────────────────────────────────────────────
//  POST /webhook — Notifications push MonCash
//  BUG FIX #5 : Traitement réel des notifications
// ─────────────────────────────────────────────
app.post('/webhook', async (req, res) => {
    console.log("🔔 Webhook MonCash reçu :", JSON.stringify(req.body));

    try {
        const { orderId, reference, transactionId } = req.body;
        const rawOrderId = orderId || reference || transactionId;

        if (!rawOrderId) {
            console.warn("⚠️  Webhook reçu sans orderId/reference.");
            return res.status(200).send("OK"); // Toujours 200 pour MonCash
        }

        const cleanOrderId = rawOrderId.toString();
        await verifyAndUpdateFirestore(cleanOrderId);

    } catch (e) {
        console.error("❌ Erreur traitement webhook:", e.message);
    }

    // Toujours répondre 200 rapidement à MonCash
    res.status(200).send("OK");
});

// Garder l'ancienne route pour compatibilité
app.post('/webhookk', async (req, res) => {
    req.url = '/webhook';
    app.handle(req, res);
});

// ─────────────────────────────────────────────
//  GET /successs — Page de retour après paiement MonCash
//  BUG FIX #3 : Déclenche automatiquement la vérification
// ─────────────────────────────────────────────
app.get('/successs', async (req, res) => {
    const { orderId } = req.query;
    let verificationStatus = "en attente";
    let packName = null;

    if (orderId && db) {
        try {
            const cleanOrderId = orderId.toString();
            const result = await verifyAndUpdateFirestore(cleanOrderId);
            verificationStatus = result.verified ? "✅ Confirmé" : "⚠️ Non confirmé";
            packName = result.packName || null;
        } catch (e) {
            console.error("❌ Erreur vérification auto /successs:", e.message);
            verificationStatus = "Erreur de vérification";
        }
    }

    res.send(`<!DOCTYPE html>
<html lang="fr">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Paiement Réussi — PNH Infos Plus</title>
    <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;600;700&display=swap" rel="stylesheet">
    <style>
        * { box-sizing: border-box; margin: 0; padding: 0; }
        body {
            font-family: 'Inter', sans-serif;
            background: linear-gradient(135deg, #f0fdf4 0%, #dcfce7 100%);
            min-height: 100vh;
            display: flex;
            align-items: center;
            justify-content: center;
        }
        .card {
            background: #fff;
            padding: 3rem 2.5rem;
            border-radius: 24px;
            box-shadow: 0 20px 60px rgba(0,0,0,.08);
            text-align: center;
            max-width: 420px;
            width: 90%;
        }
        .icon { font-size: 4rem; margin-bottom: 1.5rem; }
        h1 { font-size: 1.6rem; font-weight: 700; color: #166534; margin-bottom: .75rem; }
        p { color: #4b5563; line-height: 1.7; margin-bottom: .5rem; }
        .badge {
            display: inline-block;
            background: #dcfce7;
            color: #166534;
            border-radius: 99px;
            padding: .4rem 1.2rem;
            font-weight: 600;
            font-size: .9rem;
            margin-top: 1.5rem;
        }
        .pack { font-weight: 700; color: #1A3B8E; }
    </style>
</head>
<body>
    <div class="card">
        <div class="icon">🎉</div>
        <h1>Paiement Réussi !</h1>
        <p>Merci pour votre achat. Votre accès a été activé.</p>
        ${packName ? `<p>Pack débloqué : <span class="pack">${packName}</span></p>` : ''}
        <p>Retournez dans l'application PNH Infos Plus pour accéder à votre contenu.</p>
        <span class="badge">Statut : ${verificationStatus}</span>
    </div>
</body>
</html>`);
});

// ─────────────────────────────────────────────
//  GET /failuree — Page de retour en cas d'échec
// ─────────────────────────────────────────────
app.get('/failuree', (req, res) => {
    res.send(`<!DOCTYPE html>
<html lang="fr">
<head>
    <meta charset="UTF-8">
    <title>Paiement Échoué</title>
    <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;600;700&display=swap" rel="stylesheet">
    <style>
        * { box-sizing: border-box; margin: 0; padding: 0; }
        body { font-family: 'Inter', sans-serif; background: linear-gradient(135deg, #fff5f5 0%, #fee2e2 100%); min-height: 100vh; display: flex; align-items: center; justify-content: center; }
        .card { background: #fff; padding: 3rem 2.5rem; border-radius: 24px; box-shadow: 0 20px 60px rgba(0,0,0,.08); text-align: center; max-width: 420px; width: 90%; }
        .icon { font-size: 4rem; margin-bottom: 1.5rem; }
        h1 { font-size: 1.6rem; font-weight: 700; color: #991b1b; margin-bottom: .75rem; }
        p { color: #4b5563; line-height: 1.7; }
    </style>
</head>
<body>
    <div class="card">
        <div class="icon">❌</div>
        <h1>Paiement Annulé</h1>
        <p>Votre paiement n'a pas abouti. Aucun montant n'a été débité.</p>
        <p style="margin-top:1rem;">Vous pouvez retourner dans l'application et réessayer.</p>
    </div>
</body>
</html>`);
});

// ─────────────────────────────────────────────
//  KEEP-ALIVE — Empêche le serveur Render de dormir
// ─────────────────────────────────────────────
setInterval(() => {
    https.get(`${SERVER_URL}/health`, () => {}).on('error', () => {});
}, 10 * 60 * 1000); // Toutes les 10 minutes

// ─────────────────────────────────────────────
//  DÉMARRAGE
// ─────────────────────────────────────────────
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
    console.log(`\n🚀 Serveur MonCash actif sur le port ${PORT}`);
    console.log(`   Health check : http://localhost:${PORT}/health\n`);
});
