const express = require('express');
const axios = require('axios');
const cors = require('cors');
const path = require('path');
const https = require('https');

const app = express();
app.use(cors());
app.use(express.json());

// --- CONFIGURATION FIREBASE ---
const admin = require('firebase-admin');
let db = null;
try {
    const serviceAccount = require('./service-account.json');
    admin.initializeApp({
        credential: admin.credential.cert(serviceAccount)
    });
    db = admin.firestore();
    console.log("Firebase Admin initialisé avec succès.");
} catch (e) {
    console.error("ERREUR CRITIQUE Firebase Admin (Firestore désactivé) :", e.message);
}

// Servir les fichiers statiques (le mini-site) depuis le dossier 'public'
app.use(express.static(path.join(__dirname, 'public')));

// --- CONFIGURATION MONCASH ---
const CLIENT_ID = (process.env.MONCASH_CLIENT_ID || "").trim();
const CLIENT_SECRET = (process.env.MONCASH_CLIENT_SECRET || "").trim();
const MONCASH_ACCOUNT = (process.env.MONCASH_ACCOUNT || "").trim();
const MONCASH_MODE = (process.env.MONCASH_MODE || "sandbox").toLowerCase();

const IS_PRODUCTION = MONCASH_MODE === "live" || MONCASH_MODE === "production";

// BASE_DOMAIN est configuré selon le mode détecté (Le diagnostic a confirmé MerChantApi pour le Sandbox)
const BASE_DOMAIN = IS_PRODUCTION
    ? "https://moncashbutton.digicelgroup.com/Api"
    : "https://sandbox.moncashbutton.digicelgroup.com/Api";

const BASE_URL_REDIRECT = IS_PRODUCTION
    ? "https://moncashbutton.digicelgroup.com/Moncash-middleware"
    : "https://sandbox.moncashbutton.digicelgroup.com/Moncash-middleware";

// Vérification de sécurité
if (!CLIENT_ID || !CLIENT_SECRET) {
    console.error("ERREUR CRITIQUE : MONCASH_CLIENT_ID ou MONCASH_CLIENT_SECRET manquant sur Render !");
} else {
    console.log(`Serveur MonCash initialisé en mode ${MONCASH_MODE.toUpperCase()}`);
    console.log(`CLIENT_ID : ${CLIENT_ID ? CLIENT_ID.substring(0, 5) + '...' : 'MANQUANT'}`);
    console.log(`Compte configuré : ${MONCASH_ACCOUNT ? MONCASH_ACCOUNT.substring(0, 5) + '...' : 'AUCUN'}`);
}

const qs = require('querystring');

async function getAccessToken() {
    console.log("Démarrage getAccessToken...");
    const authString = Buffer.from(`${CLIENT_ID.trim()}:${CLIENT_SECRET.trim()}`).toString('base64');
    const data = qs.stringify({
        grant_type: 'client_credentials',
        scope: 'read,write'
    });

    try {
        console.log(`Appel OAuth sur ${BASE_DOMAIN}/oauth/token...`);
        const response = await axios.post(`${BASE_DOMAIN}/oauth/token`, data, {
            headers: {
                'Authorization': `Basic ${authString}`,
                'Content-Type': 'application/x-www-form-urlencoded',
                'User-Agent': 'MonCash-Node-Client'
            },
            timeout: 90000 
        });
        const token = response.data.access_token;
        console.log(`Token obtenu avec succès (longueur: ${token ? token.length : 0})`);
        return response.data;
    } catch (error) {
        console.error("Erreur Auth détaillée:", error.response?.data || error.message);
        throw error;
    }
}

/**
 * Endpoint de création de paiement
 */
app.post('/createpayment', async (req, res) => {
    try {
        const { amount, orderId, userId } = req.body;
        if (!amount || !orderId) {
            return res.status(400).json({ error: "Montant ou orderId manquant." });
        }

        const tokenData = await getAccessToken();
        const accessToken = tokenData.access_token;

        console.log(`Appel CreatePayment pour ${amount} HTG (orderId: ${orderId}, userId: ${userId || 'ANONYME'})...`);
        const startTime = Date.now();
        // S'assurer que orderId est uniquement numérique pour la compatibilité
        const cleanOrderId = orderId.toString().replace(/\D/g, "") || Date.now().toString();

        // 1. Sauvegarder la trace du paiement dans Firestore si userId est présent
        if (userId && db) {
            try {
                await db.collection('pending_payments').doc(cleanOrderId).set({
                    userId: userId,
                    amount: parseFloat(amount),
                    status: 'pending',
                    createdAt: admin.firestore.FieldValue.serverTimestamp()
                });
                console.log(`pending_payment enregistré pour orderId: ${cleanOrderId}`);
            } catch (e) {
                console.error("Erreur sauvegarde pending_payment:", e.message);
            }
        }

        const paymentResponse = await axios.post(
            `${BASE_DOMAIN}/v1/CreatePayment`,
            { amount: parseFloat(amount), orderId: cleanOrderId },
            {
                headers: { 
                    'Authorization': `Bearer ${accessToken}`, 
                    'Content-Type': 'application/json',
                    'Accept': 'application/json',
                    'User-Agent': 'MonCash-Node-Client'
                },
                timeout: 180000 // 180 seconds (3 minutes) - MonCash Sandbox is very slow
            }
        );
        const duration = (Date.now() - startTime) / 1000;
        console.log(`Réponse CreatePayment reçue en ${duration}s !`);

        // Extraction robuste du token (objet ou string selon API)
        const pToken = paymentResponse.data.payment_token;
        const tokenString = (typeof pToken === 'object') ? pToken.token : pToken;

        const redirectUrl = `${BASE_URL_REDIRECT}/Payment/Redirect?token=${tokenString}`;

        return res.status(200).json({
            success: true,
            redirect_url: redirectUrl,
            payment_token: tokenString
        });
    } catch (error) {
        const details = error.response?.data || error.message;
        console.error("Erreur CreatePayment:", JSON.stringify(details));
        return res.status(500).json({ error: "Erreur MonCash", details });
    }
});

app.get('/verifypayment', async (req, res) => {
    try {
        const { orderId } = req.query;
        if (!orderId) return res.status(400).json({ error: "orderId manquant." });

        const cleanOrderId = orderId.toString().replace(/\D/g, "") || orderId.toString();

        const tokenData = await getAccessToken();
        const accessToken = tokenData.access_token;

        const verifyResponse = await axios.post(
            `${BASE_DOMAIN}/V1/RetrieveTransactionPayment`,
            { transactionId: "", orderId: cleanOrderId },
            {
                headers: { 'Authorization': `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
                timeout: 60000 // 60 seconds
            }
        ).catch(() => axios.post(
            `${BASE_DOMAIN}/V1/CheckPayment`,
            { reference: cleanOrderId },
            {
                headers: { 'Authorization': `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
                timeout: 60000 // 60 seconds
            }
        ));

        const paymentData = verifyResponse.data.payment || verifyResponse.data;
        const status = paymentData.message || "inconnu";

        // 2. Si le paiement est réussi, mettre à jour le statut dans Firestore
        if (status.toUpperCase() === "SUCCESSFUL" && db) {
            try {
                const pendingRef = db.collection('pending_payments').doc(cleanOrderId);
                const doc = await pendingRef.get();

                if (doc.exists) {
                    const { userId } = doc.data();
                    if (!userId) throw new Error("userId absent dans pending_payment");
                    console.log(`Paiement réussi pour l'utilisateur : ${userId}`);

                    // Mise à jour du statut Premium (merge pour ne pas écraser le profil)
                    await db.collection('users').doc(userId).set({
                        isPremium: true,
                        lastPurchaseDate: admin.firestore.FieldValue.serverTimestamp(),
                        lastTransactionId: paymentData.transaction_id || null
                    }, { merge: true });

                    // Marquer la transaction comme traitée
                    await pendingRef.update({ status: 'completed' });
                    console.log(`✅ Statut isPremium mis à jour pour ${userId}`);
                } else {
                    console.warn(`Aucun pending_payment trouvé pour orderId: ${cleanOrderId}`);
                }
            } catch (fsError) {
                console.error("Erreur mise à jour Firestore post-paiement:", fsError.message);
            }
        }

        return res.status(200).json({
            success: true,
            status: status,
            transactionId: paymentData.transaction_id,
            reference: paymentData.reference
        });
    } catch (error) {
        const details = error.response?.data || error.message;
        console.error("Erreur verifypayment:", JSON.stringify(details));
        return res.status(500).json({ error: "Erreur verification", details });
    }
});

app.post('/webhookk', (req, res) => {
    console.log("Notification MonCash reçue :", req.body);
    res.status(200).send("OK");
});

app.get('/successs', (req, res) => {
    res.send(`
        <div style="text-align:center; padding:50px; font-family:sans-serif;">
            <h1 style="color:#2f855a;">Paiement Réussi !</h1>
            <p>Merci pour votre achat. Vous pouvez retourner dans l'application.</p>
        </div>
    `);
});

const RENDER_EXTERNAL_URL = "https://moncash-backend-5ez9.onrender.com";
setInterval(() => {
    https.get(RENDER_EXTERNAL_URL, (res) => { }).on('error', (e) => { });
}, 10 * 60 * 1000);

app.get('/test-pay-ultra', async (req, res) => {
    try {
        const tokenData = await getAccessToken();
        const accessToken = tokenData.access_token;
        const orderId = "U_" + Math.floor(Math.random() * 1000000);

        const urls = [
            `${BASE_DOMAIN}/v1/CreatePayment`,
            `${BASE_DOMAIN}/V1/InitiatePayment`,
            "https://sandbox.moncashbutton.digicelgroup.com/Moncash-middleware/v1/CreatePayment"
        ];

        const authHeaders = [
            { 'Authorization': `Bearer ${accessToken}` },
            { 'Authorization': accessToken },
            { 'X-MonCash-Token': accessToken }
        ];

        const accounts = MONCASH_ACCOUNT ? [MONCASH_ACCOUNT, MONCASH_ACCOUNT.replace('509', '')] : [''];
        const amounts = [10, "10", 10.0];
        const keys = ["reference", "orderId"];

        const results = [];
        for (const url of urls) {
            for (const auth of authHeaders) {
                for (const acc of accounts) {
                    for (const amt of amounts) {
                        for (const key of keys) {
                            try {
                                const payload = { [key]: orderId, amount: amt, account: acc };
                                const resp = await axios.post(url, payload, {
                                    headers: { ...auth, 'Content-Type': 'application/json', 'Accept': 'application/json' },
                                    timeout: 90000 // 90 seconds for test loop
                                });
                                results.push({ url, auth: Object.keys(auth)[0], acc, amt, key, status: resp.status, data: resp.data });
                            } catch (e) {
                                // On ne garde que les erreurs intéressantes (pas les 404 obvious)
                                if (e.response?.status !== 404) {
                                    results.push({ url, auth: Object.keys(auth)[0], acc, amt, key, status: e.response?.status, msg: e.response?.data?.message || e.message });
                                }
                            }
                        }
                    }
                }
            }
        }
        res.json({ 
            version: "V_90S_DIAG",
            timestamp: new Date().toISOString(),
            results: results.slice(0, 100) 
        });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`Serveur MonCash actif sur le port ${PORT}`));

