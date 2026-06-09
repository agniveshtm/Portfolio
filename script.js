// ===================== Crypto Helpers (AES-GCM via Web Crypto API) =====================
const CRYPTO_KEY_NAME = 'portfolio-encryption-key';
const CRYPTO_STORAGE_KEY = 'github-pat-encrypted';

async function getOrCreateCryptoKey() {
    const keyBase64 = localStorage.getItem(CRYPTO_KEY_NAME);
    if (keyBase64) {
        const keyBytes = base64ToBytes(keyBase64);
        return await crypto.subtle.importKey('raw', keyBytes, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
    }
    const key = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt']);
    const rawKey = await crypto.subtle.exportKey('raw', key);
    localStorage.setItem(CRYPTO_KEY_NAME, bytesToBase64(new Uint8Array(rawKey)));
    return key;
}

async function encryptToken(plaintext) {
    const key = await getOrCreateCryptoKey();
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const encoded = new TextEncoder().encode(plaintext);
    const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, encoded);
    const combined = new Uint8Array(iv.length + ciphertext.byteLength);
    combined.set(iv, 0);
    combined.set(new Uint8Array(ciphertext), iv.length);
    return bytesToBase64(combined);
}

async function decryptToken(ciphertextB64) {
    try {
        const key = await getOrCreateCryptoKey();
        const combined = base64ToBytes(ciphertextB64);
        const iv = combined.slice(0, 12);
        const ciphertext = combined.slice(12);
        const decrypted = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, ciphertext);
        return new TextDecoder().decode(decrypted);
    } catch {
        return null;
    }
}

function bytesToBase64(bytes) {
    let binary = '';
    bytes.forEach(b => binary += String.fromCharCode(b));
    return btoa(binary);
}

function base64ToBytes(base64) {
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
}

async function getStoredToken() {
    const encrypted = localStorage.getItem(CRYPTO_STORAGE_KEY);
    if (!encrypted) return null;
    return await decryptToken(encrypted);
}

async function setStoredToken(token) {
    if (!token || token.trim() === '') {
        localStorage.removeItem(CRYPTO_STORAGE_KEY);
        return;
    }
    const encrypted = await encryptToken(token.trim());
    localStorage.setItem(CRYPTO_STORAGE_KEY, encrypted);
}

async function clearStoredToken() {
    localStorage.removeItem(CRYPTO_STORAGE_KEY);
}

// ===================== IndexedDB GraphQL Cache =====================
const DB_NAME = 'PortfolioGraphQLCache';
const DB_VERSION = 1;
const STORE_NAME = 'graphql_responses';

function openDB() {
    return new Promise((resolve, reject) => {
        const request = indexedDB.open(DB_NAME, DB_VERSION);
        request.onupgradeneeded = () => {
            const db = request.result;
            if (!db.objectStoreNames.contains(STORE_NAME)) {
                const store = db.createObjectStore(STORE_NAME, { keyPath: 'queryKey' });
                store.createIndex('timestamp', 'timestamp', { unique: false });
            }
        };
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
    });
}

async function getCachedResponse(queryKey) {
    const db = await openDB();
    return new Promise((resolve) => {
        const tx = db.transaction(STORE_NAME, 'readonly');
        const store = tx.objectStore(STORE_NAME);
        const request = store.get(queryKey);
        request.onsuccess = () => {
            const entry = request.result;
            if (entry && entry.data) {
                // Cache TTL: 5 minutes
                if (Date.now() - entry.timestamp < 5 * 60 * 1000) {
                    resolve(entry.data);
                } else {
                    // Expired: remove it
                    const writeTx = db.transaction(STORE_NAME, 'readwrite');
                    writeTx.objectStore(STORE_NAME).delete(queryKey);
                    resolve(null);
                }
            } else {
                resolve(null);
            }
        };
        request.onerror = () => resolve(null);
    });
}

async function setCachedResponse(queryKey, data) {
    const db = await openDB();
    return new Promise((resolve, reject) => {
        const tx = db.transaction(STORE_NAME, 'readwrite');
        const store = tx.objectStore(STORE_NAME);
        store.put({ queryKey, data, timestamp: Date.now() });
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
    });
}

async function clearGraphQLCache() {
    const db = await openDB();
    return new Promise((resolve, reject) => {
        const tx = db.transaction(STORE_NAME, 'readwrite');
        tx.objectStore(STORE_NAME).clear();
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
    });
}

// ===================== GitHub GraphQL API Client =====================
const GITHUB_GRAPHQL_URL = 'https://api.github.com/graphql';

async function graphqlRequest(query, variables = {}) {
    const token = await getStoredToken();
    const headers = { 'Content-Type': 'application/json' };
    if (token) {
        headers['Authorization'] = `Bearer ${token}`;
    }

    const response = await fetch(GITHUB_GRAPHQL_URL, {
        method: 'POST',
        headers,
        body: JSON.stringify({ query, variables })
    });

    if (!response.ok) {
        const errText = await response.text();
        throw new Error(`GitHub GraphQL API error ${response.status}: ${errText}`);
    }

    const result = await response.json();
    if (result.errors) {
        throw new Error(`GraphQL error: ${result.errors.map(e => e.message).join(', ')}`);
    }
    return result.data;
}

async function fetchWithCache(queryKey, query, variables = {}, forceRefresh = false) {
    if (!forceRefresh) {
        const cached = await getCachedResponse(queryKey);
        if (cached) return cached;
    }

    const data = await graphqlRequest(query, variables);
    await setCachedResponse(queryKey, data);
    return data;
}

// ===================== GraphQL Queries =====================
const LATEST_RELEASE_QUERY = `
    query($owner: String!, $repo: String!) {
        repository(owner: $owner, name: $repo) {
            latestRelease {
                tagName
                name
                publishedAt
            }
        }
    }
`;

const USER_STATS_QUERY = `
    query($login: String!) {
        user(login: $login) {
            repositories(privacy: PUBLIC, first: 100, orderBy: {field: UPDATED_AT, direction: DESC}) {
                totalCount
                nodes {
                    name
                    stargazerCount
                    updatedAt
                    description
                    primaryLanguage { name }
                }
            }
            followers { totalCount }
            repositoriesContributedTo(first: 1, contributionTypes: [COMMIT, PULL_REQUEST, ISSUE]) {
                totalCount
            }
        }
    }
`;

const REPO_LANGUAGES_QUERY = `
    query($owner: String!, $repo: String!) {
        repository(owner: $owner, name: $repo) {
            languages(first: 10, orderBy: {field: SIZE, direction: DESC}) {
                nodes { name }
            }
        }
    }
`;

// ===================== Data Fetching Functions =====================
async function fetchLatestRelease() {
    const repoFull = 'agniveshtm/todo-tui';
    const [owner, repo] = repoFull.split('/');
    const queryKey = `latestRelease_${repoFull}`;

    try {
        const data = await fetchWithCache(queryKey, LATEST_RELEASE_QUERY, { owner, repo });
        if (data && data.repository && data.repository.latestRelease) {
            const tagName = data.repository.latestRelease.tagName;
            document.querySelectorAll('.version-tag[data-repo="agniveshtm/todo-tui"]').forEach(el => {
                el.textContent = tagName;
            });
            const releaseVersionEl = document.querySelector('.release-version');
            if (releaseVersionEl) releaseVersionEl.textContent = tagName;
        }
    } catch (err) {
        console.warn('Failed to fetch latest release (GraphQL):', err);
    }
}

async function fetchGitHubStats() {
    const queryKey = 'userStats_agniveshtm';
    try {
        const data = await fetchWithCache(queryKey, USER_STATS_QUERY, { login: 'agniveshtm' });
        if (data && data.user) {
            const user = data.user;
            const repoCount = user.repositories.totalCount;
            const followers = user.followers.totalCount;
            const totalStars = user.repositories.nodes.reduce((sum, r) => sum + r.stargazerCount, 0);

            const statCards = document.querySelectorAll('.stat-card');
            if (statCards.length >= 3) {
                const repoEl = statCards[0].querySelector('.stat-number');
                const followersEl = statCards[1].querySelector('.stat-number');
                const starsEl = statCards[2].querySelector('.stat-number');

                if (repoEl) repoEl.textContent = repoCount;
                if (followersEl) followersEl.textContent = followers;
                if (starsEl) starsEl.textContent = totalStars;
            }
        }
    } catch (err) {
        console.warn('Failed to fetch GitHub stats (GraphQL):', err);
    }
}

// ===================== Mobile Navigation Toggle =====================
const navToggle = document.getElementById('navToggle');
const navMenu = document.getElementById('navMenu');
const navLinks = document.querySelectorAll('.nav-link');

navToggle.addEventListener('click', () => {
    navToggle.classList.toggle('active');
    navMenu.classList.toggle('active');
});

navLinks.forEach(link => {
    link.addEventListener('click', () => {
        navToggle.classList.remove('active');
        navMenu.classList.remove('active');
    });
});

// ===================== Active Navigation Link on Scroll =====================
const sections = document.querySelectorAll('section[id]');

function updateActiveLink() {
    let current = '';
    const scrollY = window.scrollY + 100;

    sections.forEach(section => {
        const sectionTop = section.offsetTop;
        const sectionHeight = section.offsetHeight;

        if (scrollY >= sectionTop && scrollY < sectionTop + sectionHeight) {
            current = section.getAttribute('id');
        }
    });

    navLinks.forEach(link => {
        link.classList.remove('active');
        if (link.getAttribute('href') === `#${current}`) {
            link.classList.add('active');
        }
    });
}

window.addEventListener('scroll', updateActiveLink);

// ===================== Smooth scroll indicator hide =====================
const scrollIndicator = document.querySelector('.scroll-indicator');

window.addEventListener('scroll', () => {
    if (window.scrollY > window.innerHeight * 0.8) {
        scrollIndicator.style.opacity = '0';
    } else {
        scrollIndicator.style.opacity = '1';
    }
});

// ===================== Intersection Observer for Animations =====================
const observerOptions = {
    threshold: 0.1,
    rootMargin: '0px 0px -50px 0px'
};

const observer = new IntersectionObserver((entries) => {
    entries.forEach(entry => {
        if (entry.isIntersecting) {
            entry.target.classList.add('visible');
            observer.unobserve(entry.target);
        }
    });
}, observerOptions);

const animatedElements = document.querySelectorAll(
    '.about-card, .project-card, .project-featured, .skill-category, .stat-card, .contact-item, .stack-highlight'
);

animatedElements.forEach(el => {
    el.style.opacity = '0';
    el.style.transform = 'translateY(30px)';
    el.style.transition = 'opacity 0.6s ease-out, transform 0.6s ease-out';
    observer.observe(el);
});

// Add visible class styles dynamically
document.addEventListener('DOMContentLoaded', () => {
    const style = document.createElement('style');
    style.textContent = `
        .visible {
            opacity: 1 !important;
            transform: translateY(0) !important;
        }
    `;
    document.head.appendChild(style);
});

// ===================== Parallax effect on hero background =====================
const heroBg = document.querySelector('.hero-bg');

window.addEventListener('mousemove', (e) => {
    if (window.innerWidth > 768 && heroBg) {
        const x = (e.clientX / window.innerWidth - 0.5) * 20;
        const y = (e.clientY / window.innerHeight - 0.5) * 20;
        heroBg.style.transform = `translate(${x}px, ${y}px)`;
    }
});

// ===================== Token Modal Logic =====================
const tokenModal = document.getElementById('tokenModal');
const tokenBtn = document.getElementById('tokenBtn');
const modalClose = document.getElementById('modalClose');
const patInput = document.getElementById('patInput');
const tokenVisibilityToggle = document.getElementById('tokenVisibilityToggle');
const tokenSaveBtn = document.getElementById('tokenSaveBtn');
const tokenClearBtn = document.getElementById('tokenClearBtn');
const tokenStatus = document.getElementById('tokenStatus');
const tokenStatusText = document.getElementById('tokenStatusText');
const tokenStatusDot = document.getElementById('tokenStatusDot');

function openModal() {
    tokenModal.classList.add('active');
    populateInputFromStorage();
}

function closeModal() {
    tokenModal.classList.remove('active');
}

function toggleTokenVisibility() {
    const isPassword = patInput.type === 'password';
    patInput.type = isPassword ? 'text' : 'password';
    tokenVisibilityToggle.innerHTML = isPassword ? '<i class="fas fa-eye-slash"></i>' : '<i class="fas fa-eye"></i>';
}

async function populateInputFromStorage() {
    const token = await getStoredToken();
    patInput.value = token || '';
}

async function updateTokenStatusDot() {
    const token = await getStoredToken();
    if (token) {
        tokenStatusDot.style.background = '#50fa7b';
        tokenStatusDot.style.boxShadow = '0 0 6px #50fa7b';
        tokenBtn.title = 'Token configured';
    } else {
        tokenStatusDot.style.background = '#ff5f57';
        tokenStatusDot.style.boxShadow = '0 0 6px #ff5f57';
        tokenBtn.title = 'No token configured';
    }
}

function showTokenStatus(message, isError = false) {
    tokenStatus.style.display = 'flex';
    tokenStatusText.textContent = message;
    const icon = tokenStatus.querySelector('i');
    if (isError) {
        icon.className = 'fas fa-exclamation-circle';
        icon.style.color = '#ff5f57';
        tokenStatusText.style.color = '#ff5f57';
    } else {
        icon.className = 'fas fa-check-circle';
        icon.style.color = '#50fa7b';
        tokenStatusText.style.color = '#50fa7b';
    }
    setTimeout(() => {
        tokenStatus.style.display = 'none';
    }, 4000);
}

async function validateAndSaveToken() {
    const token = patInput.value.trim();
    if (!token) {
        showTokenStatus('Please enter a token.', true);
        return;
    }

    // Basic format check for GitHub PAT
    if (!token.startsWith('ghp_') && !token.startsWith('github_pat_') && !token.startsWith('gho_') && !token.startsWith('ghu_') && !token.startsWith('ghs_') && !token.startsWith('ghr_')) {
        showTokenStatus('Token format may be invalid (expected ghp_... or github_pat_...). Saving anyway.', true);
    }

    try {
        // Test the token with a simple GraphQL query
        const testQuery = `query { viewer { login } }`;
        const testHeaders = { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` };
        const testResp = await fetch(GITHUB_GRAPHQL_URL, {
            method: 'POST',
            headers: testHeaders,
            body: JSON.stringify({ query: testQuery })
        });

        if (!testResp.ok) {
            const errText = await testResp.text();
            showTokenStatus(`Token validation failed (HTTP ${testResp.status}). Not saved.`, true);
            return;
        }

        const testResult = await testResp.json();
        if (testResult.errors) {
            showTokenStatus(`Token invalid: ${testResult.errors[0].message}. Not saved.`, true);
            return;
        }

        // Token is valid — save it encrypted
        await setStoredToken(token);
        await updateTokenStatusDot();
        // Invalidate cache so next fetch uses authenticated requests
        await clearGraphQLCache();
        showTokenStatus(`Token saved successfully! Authenticated as ${testResult.data.viewer.login}`);

        // Re-fetch data with authenticated requests
        fetchLatestRelease();
        fetchGitHubStats();

        // Close modal after short delay
        setTimeout(closeModal, 1500);
    } catch (err) {
        showTokenStatus(`Cannot reach GitHub: ${err.message}. Saving anyway.`, true);
        await setStoredToken(token);
        await updateTokenStatusDot();
    }
}

async function clearToken() {
    await clearStoredToken();
    await clearGraphQLCache();
    patInput.value = '';
    await updateTokenStatusDot();
    showTokenStatus('Token cleared. Using unauthenticated requests.');
}

// Modal event listeners
tokenBtn.addEventListener('click', openModal);
modalClose.addEventListener('click', closeModal);
tokenModal.addEventListener('click', (e) => {
    if (e.target === tokenModal) closeModal();
});
tokenVisibilityToggle.addEventListener('click', toggleTokenVisibility);
tokenSaveBtn.addEventListener('click', validateAndSaveToken);
tokenClearBtn.addEventListener('click', clearToken);

// ===================== Init =====================
document.addEventListener('DOMContentLoaded', async () => {
    await updateTokenStatusDot();

    // If token is configured, fetch with auth (will use cache otherwise)
    fetchLatestRelease();
    fetchGitHubStats();
});