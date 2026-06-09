// ===================== Token from URL (?pat=) =====================
function getTokenFromURL() {
    const params = new URLSearchParams(window.location.search);
    return params.get('pat') || null;
}

function getStoredToken() {
    return getTokenFromURL();
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
                if (Date.now() - entry.timestamp < 5 * 60 * 1000) {
                    resolve(entry.data);
                } else {
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
    const token = getStoredToken();
    const headers = { 'Content-Type': 'application/json' };
    if (token) {
        headers['Authorization'] = `Bearer ${token}`;
        console.log('[GitHub] Using authenticated request (Bearer token from ?pat=)');
    } else {
        console.log('[GitHub] Using unauthenticated request');
    }

    const response = await fetch(GITHUB_GRAPHQL_URL, {
        method: 'POST',
        headers,
        body: JSON.stringify({ query, variables })
    });

    console.log('[GitHub] Response status:', response.status);

    if (!response.ok) {
        const errText = await response.text();
        throw new Error(`GitHub GraphQL API error ${response.status}: ${errText}`);
    }

    const result = await response.json();
    if (result.errors) {
        console.warn('[GitHub] GraphQL errors in response:', result.errors);
        throw new Error(`GraphQL error: ${result.errors.map(e => e.message).join(', ')}`);
    }
    return result.data;
}

async function fetchWithCache(queryKey, query, variables = {}, forceRefresh = false) {
    if (!forceRefresh) {
        const cached = await getCachedResponse(queryKey);
        if (cached) {
            console.log('[Cache] Serving cached response for:', queryKey);
            return cached;
        }
    }

    console.log('[GitHub] Fetching:', queryKey);
    const data = await graphqlRequest(query, variables);
    await setCachedResponse(queryKey, data);
    return data;
}

// ===================== GraphQL Queries =====================
// Note: latestRelease requires auth for some repos; without auth it returns null silently
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

// Split user stats into multiple smaller queries to avoid partial failures
const USER_REPOS_QUERY = `
    query($login: String!) {
        user(login: $login) {
            repositories(privacy: PUBLIC, first: 100, orderBy: {field: UPDATED_AT, direction: DESC}) {
                totalCount
                nodes {
                    stargazerCount
                }
            }
            followers { totalCount }
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
        console.log('[Fetch] Release data:', data);
        if (data && data.repository && data.repository.latestRelease) {
            const tagName = data.repository.latestRelease.tagName;
            document.querySelectorAll('.version-tag[data-repo="agniveshtm/todo-tui"]').forEach(el => {
                el.textContent = tagName;
            });
            const releaseVersionEl = document.querySelector('.release-version');
            if (releaseVersionEl) releaseVersionEl.textContent = tagName;
        } else {
            console.log('[Fetch] No latest release found (may need auth token)');
        }
    } catch (err) {
        console.warn('[Fetch] Failed to fetch latest release (GraphQL):', err.message);
    }
}

async function fetchGitHubStats() {
    const queryKey = 'userStats_agniveshtm';
    try {
        const data = await fetchWithCache(queryKey, USER_REPOS_QUERY, { login: 'agniveshtm' });
        console.log('[Fetch] User stats data:', data);
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
        console.warn('[Fetch] Failed to fetch GitHub stats (GraphQL):', err.message);
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

// ===================== Token Modal Logic (URL-based ?pat=) =====================
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
    const currentToken = getStoredToken();
    patInput.value = currentToken || '';
}

function closeModal() {
    tokenModal.classList.remove('active');
}

function toggleTokenVisibility() {
    const isPassword = patInput.type === 'password';
    patInput.type = isPassword ? 'text' : 'password';
    tokenVisibilityToggle.innerHTML = isPassword ? '<i class="fas fa-eye-slash"></i>' : '<i class="fas fa-eye"></i>';
}

function updateTokenStatusDot() {
    const token = getStoredToken();
    if (token) {
        tokenStatusDot.style.background = '#50fa7b';
        tokenStatusDot.style.boxShadow = '0 0 6px #50fa7b';
        tokenBtn.title = 'Token configured via URL (?pat=...)';
    } else {
        tokenStatusDot.style.background = '#ff5f57';
        tokenStatusDot.style.boxShadow = '0 0 6px #ff5f57';
        tokenBtn.title = 'No token. Add ?pat=YOUR_TOKEN to URL';
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
    }, 5000);
}

async function validateAndSaveToken() {
    const token = patInput.value.trim();
    if (!token) {
        showTokenStatus('Please enter a token.', true);
        return;
    }

    try {
        // Test the token with a simple GraphQL query
        const testQuery = `query { viewer { login } }`;
        const testResp = await fetch(GITHUB_GRAPHQL_URL, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${token}`
            },
            body: JSON.stringify({ query: testQuery })
        });

        if (!testResp.ok) {
            const errText = await testResp.text();
            showTokenStatus(`Token validation failed (HTTP ${testResp.status})`, true);
            console.error('[Token] Validation error:', errText);
            return;
        }

        const testResult = await testResp.json();
        if (testResult.errors) {
            showTokenStatus(`Token invalid: ${testResult.errors[0].message}`, true);
            return;
        }

        // Token is valid — update URL with ?pat= via replaceState (no reload)
        const url = new URL(window.location.href);
        url.searchParams.set('pat', token);
        window.history.replaceState({}, '', url.toString());

        await clearGraphQLCache();
        updateTokenStatusDot();
        showTokenStatus(`Token saved! Authenticated as ${testResult.data.viewer.login}`);

        // Re-fetch with auth
        fetchLatestRelease();
        fetchGitHubStats();

        setTimeout(closeModal, 1500);
    } catch (err) {
        showTokenStatus(`Error: ${err.message}`, true);
    }
}

async function clearToken() {
    const url = new URL(window.location.href);
    url.searchParams.delete('pat');
    window.history.replaceState({}, '', url.toString());

    await clearGraphQLCache();
    patInput.value = '';
    updateTokenStatusDot();
    showTokenStatus('Token cleared from URL. Using unauthenticated requests.');

    fetchLatestRelease();
    fetchGitHubStats();
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
document.addEventListener('DOMContentLoaded', () => {
    const token = getStoredToken();
    console.log('[Init] Page loaded. Token from URL:', token ? '***present***' : 'none');
    console.log('[Init] Current URL:', window.location.href);
    console.log('[Init] Query string:', window.location.search);
    updateTokenStatusDot();
    fetchLatestRelease();
    fetchGitHubStats();
});