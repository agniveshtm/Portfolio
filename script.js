// ===================== Token Management =====================
const TOKEN_STORAGE_KEY = 'gh_pat';

function getTokenFromURL() {
    const params = new URLSearchParams(window.location.search);
    const pat = params.get('pat');
    if (pat) {
        localStorage.setItem(TOKEN_STORAGE_KEY, pat);
        window.history.replaceState({}, '', window.location.pathname);
    }
    return pat || null;
}

function getStoredToken() {
    return getTokenFromURL() || localStorage.getItem(TOKEN_STORAGE_KEY);
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

const LOCAL_STORAGE_KEY = 'portfolio_repos_cache';

async function getCachedResponse(queryKey, ttlMs = 5 * 60 * 1000) {
    const db = await openDB();
    return new Promise((resolve) => {
        const tx = db.transaction(STORE_NAME, 'readonly');
        const store = tx.objectStore(STORE_NAME);
        const request = store.get(queryKey);
        request.onsuccess = () => {
            const entry = request.result;
            if (entry && entry.data) {
                const age = Date.now() - entry.timestamp;
                resolve({
                    data: entry.data,
                    timestamp: entry.timestamp,
                    fresh: age < ttlMs,
                });
            } else {
                resolve(null);
            }
        };
        request.onerror = () => resolve(null);
    });
}

function getCachedFromStorage() {
    try {
        const raw = localStorage.getItem(LOCAL_STORAGE_KEY);
        if (!raw) return null;
        const entry = JSON.parse(raw);
        if (entry && entry.data && entry.timestamp) {
            return { data: entry.data, timestamp: entry.timestamp, fresh: true };
        }
    } catch {}
    return null;
}

function saveCacheToStorage(data) {
    try {
        localStorage.setItem(LOCAL_STORAGE_KEY, JSON.stringify({
            data,
            timestamp: Date.now(),
        }));
    } catch {}
}

async function setCachedResponse(queryKey, data) {
    const db = await openDB();
    saveCacheToStorage(data);
    return new Promise((resolve, reject) => {
        const tx = db.transaction(STORE_NAME, 'readwrite');
        const store = tx.objectStore(STORE_NAME);
        store.put({ queryKey, data, timestamp: Date.now() });
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
    });
}

// ===================== GitHub GraphQL API Client =====================
const GITHUB_GRAPHQL_URL = 'https://api.github.com/graphql';

function isRateLimited(response) {
    return response.status === 403 || response.status === 429;
}

function getRateLimitInfo(response) {
    return {
        remaining: parseInt(response.headers.get('x-ratelimit-remaining') || '0', 10),
        limit: parseInt(response.headers.get('x-ratelimit-limit') || '0', 10),
        reset: parseInt(response.headers.get('x-ratelimit-reset') || '0', 10) * 1000,
    };
}

async function graphqlRequest(query, variables = {}) {
    const token = getStoredToken();
    const headers = { 'Content-Type': 'application/json' };
    if (token) {
        headers['Authorization'] = `Bearer ${token}`;
    }

    const response = await fetch(GITHUB_GRAPHQL_URL, {
        method: 'POST',
        headers,
        body: JSON.stringify({ query, variables })
    });

    const rateInfo = getRateLimitInfo(response);

    if (isRateLimited(response)) {
        const resetIn = Math.max(0, Math.ceil((rateInfo.reset - Date.now()) / 60000));
        const err = new Error('RATE_LIMITED');
        err.resetIn = resetIn;
        err.rateInfo = rateInfo;
        throw err;
    }

    if (!response.ok) {
        const errText = await response.text();
        throw new Error(`GitHub API error ${response.status}: ${errText}`);
    }

    const result = await response.json();
    if (result.errors) {
        throw new Error(`GraphQL error: ${result.errors.map(e => e.message).join(', ')}`);
    }
    return result.data;
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

const USER_REPOS_QUERY = `
    query($login: String!, $cursor: String) {
        user(login: $login) {
            repositories(
                privacy: PUBLIC
                first: 100
                after: $cursor
                orderBy: { field: UPDATED_AT, direction: DESC }
            ) {
                pageInfo { hasNextPage endCursor }
                totalCount
                nodes {
                    name
                    nameWithOwner
                    description
                    url
                    homepageUrl
                    createdAt
                    updatedAt
                    pushedAt
                    stargazerCount
                    forkCount
                    isArchived
                    isFork
                    primaryLanguage { name color }
                    repositoryTopics(first: 20) {
                        nodes { topic { name } }
                    }
                }
            }
            followers { totalCount }
        }
    }
`;

// ===================== REST API Fallback =====================
const GITHUB_API_BASE = 'https://api.github.com';

async function restFetch(url) {
    const token = getStoredToken();
    const headers = {};
    if (token) headers['Authorization'] = `Bearer ${token}`;
    const response = await fetch(url, { headers });
    if (response.status === 403 || response.status === 429) {
        const reset = parseInt(response.headers.get('x-ratelimit-reset') || '0', 10) * 1000;
        const err = new Error('RATE_LIMITED');
        err.resetIn = Math.max(0, Math.ceil((reset - Date.now()) / 60000));
        throw err;
    }
    if (!response.ok) throw new Error(`GitHub API error ${response.status}`);
    return response.json();
}

async function fetchReposViaREST(login) {
    const allRepos = [];
    let page = 1;
    while (true) {
        const repos = await restFetch(`${GITHUB_API_BASE}/users/${login}/repos?per_page=100&page=${page}&sort=pushed&direction=desc&type=public`);
        if (!repos.length) break;
        allRepos.push(...repos);
        if (repos.length < 100) break;
        page++;
    }
    const user = await restFetch(`${GITHUB_API_BASE}/users/${login}`);
    return {
        repos: allRepos.map(r => ({
            name: r.name,
            nameWithOwner: r.full_name,
            description: r.description,
            url: r.html_url,
            homepageUrl: r.homepage,
            createdAt: r.created_at,
            updatedAt: r.updated_at,
            pushedAt: r.pushed_at,
            stargazerCount: r.stargazers_count,
            forkCount: r.forks_count,
            isArchived: r.archived,
            isFork: r.fork,
            primaryLanguage: r.language ? { name: r.language, color: null } : null,
            repositoryTopics: { nodes: (r.topics || []).map(t => ({ topic: { name: t } })) },
        })),
        followers: user.followers,
        totalCount: user.public_repos,
    };
}

async function fetchReleaseViaREST(owner, repo) {
    const data = await restFetch(`${GITHUB_API_BASE}/repos/${owner}/${repo}/releases/latest`);
    return { repository: { latestRelease: { tagName: data.tag_name } } };
}

// ===================== Repo Metadata Overrides =====================
const REPO_OVERRIDES = {
    'todo-tui': {
        icon: 'fas fa-terminal',
        customDesc: 'A feature-rich, keyboard-driven TUI todo app built with Python & Textual',
        pinned: true,
        featured: true,
    },
    'Carbon_Scope': {
        icon: 'fas fa-leaf',
        customDesc: 'Carbon footprint analysis and environmental impact tracking tool',
    },
    'SCHOOLARTSPLANNER': {
        icon: 'fas fa-school',
        customDesc: 'School arts festival management system — events, participants, winners & certificates',
    },
    'stock-analysis': {
        icon: 'fas fa-chart-line',
        customDesc: 'Stock market analysis with performance-optimized Cython processing',
    },
    'DJANGO': {
        icon: 'fab fa-python',
        customDesc: 'Full-stack web applications built with Django',
    },
};

// ===================== RepoManager =====================
const RepoManager = {
    cacheKey: 'allRepos_agniveshtm',
    cacheTTL: 24 * 60 * 60 * 1000, // 24 hours
    refreshInterval: 12 * 60 * 60 * 1000,
    _timer: null,
    _repos: [],
    _sort: 'stars',

    init() {
        this.grid = document.getElementById('reposGrid');
        this.status = document.getElementById('reposStatus');
        if (!this.grid) return;

        this.bindFilters();
        this.load();
        this.startAutoRefresh();
    },

    bindFilters() {
        document.querySelectorAll('.filter-btn[data-sort]').forEach(btn => {
            btn.addEventListener('click', () => {
                document.querySelectorAll('.filter-btn[data-sort]').forEach(b => b.classList.remove('active'));
                btn.classList.add('active');
                this._sort = btn.dataset.sort;
                this.render();
            });
        });
    },

    async load() {
        try {
            const cached = await getCachedResponse(this.cacheKey, this.cacheTTL);
            if (cached) {
                this._repos = cached.data;
                this._lastFetched = cached.timestamp;
                this.render();
                this.fetchFresh();
                return;
            }
        } catch {}

        const lsCache = getCachedFromStorage();
        if (lsCache) {
            this._repos = lsCache.data;
            this._lastFetched = lsCache.timestamp;
            this.render();
            this.fetchFresh();
            return;
        }

        await this.fetchFresh();
    },

    async fetchFresh() {
        try {
            const allRepos = [];
            let cursor = null;
            let totalCount = 0;
            let followers = 0;

            do {
                const data = await graphqlRequest(USER_REPOS_QUERY, { login: 'agniveshtm', cursor });
                const user = data.user;
                if (!user) break;

                if (cursor === null) {
                    totalCount = user.repositories.totalCount;
                    followers = user.followers.totalCount;
                }

                const repos = user.repositories.nodes.filter(r => !r.isFork && !r.isArchived);
                allRepos.push(...repos);
                cursor = user.repositories.pageInfo.hasNextPage ? user.repositories.pageInfo.endCursor : null;
            } while (cursor);

            this._repos = allRepos;
            this._followers = followers;
            this._totalCount = totalCount;
            this._lastFetched = Date.now();

            await setCachedResponse(this.cacheKey, allRepos);
            this.render();
            this.updateStats(totalCount, followers, allRepos);
        } catch (err) {
            console.warn('[RepoManager] GraphQL failed, trying REST fallback:', err.message);

            try {
                const { repos, followers, totalCount } = await fetchReposViaREST('agniveshtm');
                this._repos = repos;
                this._followers = followers;
                this._totalCount = totalCount;
                this._lastFetched = Date.now();
                await setCachedResponse(this.cacheKey, repos);
                this.render();
                this.updateStats(totalCount, followers, repos);
                return;
            } catch (restErr) {
                console.warn('[RepoManager] REST fallback also failed:', restErr.message);
            }

            if (err.message === 'RATE_LIMITED') {
                this._rateLimitError = err;
                if (this._repos.length > 0) {
                    this.renderRateLimitBanner(err);
                } else {
                    const lsCache = getCachedFromStorage();
                    if (lsCache) {
                        this._repos = lsCache.data;
                        this._lastFetched = lsCache.timestamp;
                        this.render();
                        this.renderRateLimitBanner(err);
                    } else {
                        this.renderRateLimit(err);
                    }
                }
            } else if (this._repos.length === 0) {
                this.renderError(err.message);
            }
        }
    },

    updateStats(totalCount, followers, repos) {
        const totalStars = repos.reduce((sum, r) => sum + r.stargazerCount, 0);
        const statCards = document.querySelectorAll('.stat-card');
        if (statCards.length >= 3) {
            const repoEl = statCards[0].querySelector('.stat-number');
            const followersEl = statCards[1].querySelector('.stat-number');
            const starsEl = statCards[2].querySelector('.stat-number');
            if (repoEl) { repoEl.dataset.target = totalCount; repoEl.textContent = totalCount; }
            if (followersEl) { followersEl.dataset.target = followers; followersEl.textContent = followers; }
            if (starsEl) { starsEl.dataset.target = totalStars; starsEl.textContent = totalStars; }
        }
    },

    getSorted() {
        const repos = [...this._repos];
        switch (this._sort) {
            case 'stars':
                return repos.sort((a, b) => b.stargazerCount - a.stargazerCount);
            case 'updated':
                return repos.sort((a, b) => new Date(b.pushedAt) - new Date(a.pushedAt));
            case 'name':
                return repos.sort((a, b) => a.name.localeCompare(b.name));
            default:
                return repos;
        }
    },

    render() {
        if (!this.grid) return;

        const sorted = this.getSorted();
        if (sorted.length === 0) {
            this.grid.innerHTML = `
                <div class="repos-empty">
                    <i class="fas fa-box-open"></i>
                    <p>No public repos found</p>
                </div>`;
            return;
        }

        this.grid.innerHTML = sorted.map((repo, i) => this.cardHTML(repo, i)).join('');
        this.updateStatus();

        this.grid.querySelectorAll('.project-card').forEach((card, i) => {
            card.classList.add('reveal');
            card.style.transitionDelay = `${i * 60}ms`;
            observer.observe(card);
        });
    },

    cardHTML(repo, index) {
        const override = REPO_OVERRIDES[repo.name] || {};
        const icon = override.icon || this.langIcon(repo.primaryLanguage?.name);
        const desc = override.customDesc || repo.description || 'No description provided';
        const lang = repo.primaryLanguage?.name || '';
        const langColor = repo.primaryLanguage?.color || '#6e7681';
        const stars = repo.stargazerCount;
        const topics = repo.repositoryTopics?.nodes?.map(t => t.topic.name) || [];
        const updated = this.timeAgo(new Date(repo.pushedAt));
        const homepage = repo.homepageUrl;
        const displayTopics = topics.filter(t => !['python', 'javascript', 'html', 'css'].includes(t)).slice(0, 5);

        return `
            <div class="project-card" style="animation-delay: ${index * 60}ms">
                <div class="project-card-header">
                    <i class="${icon} project-icon${lang === 'Python' ? ' django-icon' : ''}"></i>
                    <div class="project-card-links">
                        ${stars > 0 ? `<span class="repo-stars"><i class="fas fa-star"></i> ${stars}</span>` : ''}
                        <a href="${repo.url}" target="_blank" aria-label="GitHub"><i class="fab fa-github"></i></a>
                    </div>
                </div>
                <h3>${repo.name}</h3>
                <p class="project-type">${lang ? lang + ' · ' : ''}${this.categoryFromTopics(topics)}</p>
                <p>${this.escapeHTML(desc)}</p>
                ${homepage ? `<a href="${homepage}" target="_blank" class="repo-homepage"><i class="fas fa-external-link-alt"></i> ${this.cleanURL(homepage)}</a>` : ''}
                ${displayTopics.length > 0 ? `<div class="repo-topics">${displayTopics.map(t => `<span>${t}</span>`).join('')}</div>` : ''}
                <div class="repo-meta">
                    ${lang ? `<span><span class="lang-dot" style="background:${langColor}"></span> ${lang}</span>` : ''}
                    <span><i class="fas fa-code-branch"></i> ${repo.forkCount} forks</span>
                </div>
                <div class="repo-updated">Updated ${updated}</div>
            </div>`;
    },

    langIcon(lang) {
        const map = {
            'Python': 'fab fa-python',
            'JavaScript': 'fab fa-js',
            'HTML': 'fab fa-html5',
            'CSS': 'fab fa-css3-alt',
            'Java': 'fab fa-java',
            'C': 'fas fa-c',
            'C++': 'fas fa-c',
            'Shell': 'fas fa-terminal',
            'Dockerfile': 'fab fa-docker',
            'TypeScript': 'fas fa-code',
            'Ruby': 'fas fa-gem',
            'Rust': 'fas fa-cog',
            'Go': 'fas fa-server',
            'PHP': 'fab fa-php',
            'Vue': 'fab fa-vuejs',
        };
        return map[lang] || 'fas fa-code';
    },

    categoryFromTopics(topics) {
        const t = topics.map(x => x.toLowerCase());
        if (t.includes('django') || t.includes('web')) return 'Full-Stack Web';
        if (t.includes('machine-learning') || t.includes('ml') || t.includes('data-science')) return 'ML & Data';
        if (t.includes('cli') || t.includes('tui') || t.includes('terminal')) return 'CLI / TUI';
        if (t.includes('devops') || t.includes('docker') || t.includes('kubernetes')) return 'DevOps';
        if (t.includes('python')) return 'Python';
        return 'Project';
    },

    timeAgo(date) {
        const seconds = Math.floor((Date.now() - date.getTime()) / 1000);
        if (seconds < 60) return 'just now';
        const minutes = Math.floor(seconds / 60);
        if (minutes < 60) return `${minutes}m ago`;
        const hours = Math.floor(minutes / 60);
        if (hours < 24) return `${hours}h ago`;
        const days = Math.floor(hours / 24);
        if (days < 30) return `${days}d ago`;
        const months = Math.floor(days / 30);
        if (months < 12) return `${months}mo ago`;
        return `${Math.floor(months / 12)}y ago`;
    },

    cleanURL(url) {
        try { return new URL(url).hostname; } catch { return url; }
    },

    escapeHTML(str) {
        const div = document.createElement('div');
        div.textContent = str;
        return div.innerHTML;
    },

    updateStatus() {
        if (!this.status) return;
        const count = this._repos.length;
        const countEl = this.status.querySelector('.repos-count');
        const updatedEl = this.status.querySelector('.repos-updated');
        if (countEl) countEl.textContent = `${count} repo${count !== 1 ? 's' : ''}`;
        if (updatedEl && this._lastFetched) {
            updatedEl.textContent = `live ${this.timeAgo(new Date(this._lastFetched))}`;
        }
    },

    renderError(msg) {
        if (!this.grid) return;
        this.grid.innerHTML = `
            <div class="repos-error">
                <p><i class="fas fa-exclamation-triangle"></i> Failed to load repos: ${this.escapeHTML(msg)}</p>
                <button onclick="RepoManager.fetchFresh()"><i class="fas fa-redo"></i> Retry</button>
            </div>`;
    },

    renderRateLimit(err) {
        if (!this.grid) return;
        this.grid.innerHTML = `
            <div class="repos-error rate-limited">
                <i class="fas fa-clock"></i>
                <p><strong>Rate limit reached</strong></p>
                <p class="rate-limit-detail">Data refreshes in ~${err.resetIn} min. Cached results are shown below.</p>
                <button class="retry-btn" onclick="RepoManager.fetchFresh()"><i class="fas fa-redo"></i> Retry</button>
            </div>`;
    },

    renderRateLimitBanner(err) {
        const existing = document.querySelector('.rate-limit-banner');
        if (existing) return;
        const banner = document.createElement('div');
        banner.className = 'rate-limit-banner';
        banner.innerHTML = `
            <i class="fas fa-exclamation-circle"></i>
            <span>Rate limited — resets in ~${err.resetIn}m</span>
            <button onclick="this.parentElement.remove()" class="banner-close">&times;</button>`;
        this.grid.parentElement.insertBefore(banner, this.grid);
    },

    startAutoRefresh() {
        this._timer = setInterval(() => this.fetchFresh(), this.refreshInterval);
    },

    destroy() {
        if (this._timer) clearInterval(this._timer);
    }
};

// ===================== Release Fetcher =====================
async function fetchLatestRelease() {
    const repoFull = 'agniveshtm/todo-tui';
    const [owner, repo] = repoFull.split('/');
    const queryKey = `latestRelease_${repoFull}`;

    try {
        const cached = await getCachedResponse(queryKey, 5 * 60 * 1000);
        const data = cached ? cached.data : await (async () => {
            try {
                const d = await graphqlRequest(LATEST_RELEASE_QUERY, { owner, repo });
                await setCachedResponse(queryKey, d);
                return d;
            } catch {
                const d = await fetchReleaseViaREST(owner, repo);
                await setCachedResponse(queryKey, d);
                return d;
            }
        })();

        if (data?.repository?.latestRelease) {
            const tagName = data.repository.latestRelease.tagName;
            document.querySelectorAll('.version-tag[data-repo="agniveshtm/todo-tui"]').forEach(el => {
                el.textContent = tagName;
            });
            const releaseVersionEl = document.querySelector('.release-version');
            if (releaseVersionEl) releaseVersionEl.textContent = tagName;
        }
    } catch (err) {
        console.warn('[Fetch] Failed to fetch latest release:', err.message);
    }
}

// ===================== Typing Effect =====================
function initTypingEffect() {
    const el = document.getElementById('typingText');
    if (!el) return;

    const phrases = [
        'CS Student · Vibe-Coder · ML & Web Developer',
        'Django Enthusiast · Linux Explorer',
        'Building AI-Powered Web Apps',
        'Turning Ideas into Code ⚡'
    ];

    let phraseIndex = 0;
    let charIndex = 0;
    let isDeleting = false;
    let isPaused = false;

    function tick() {
        const current = phrases[phraseIndex];

        if (isPaused) {
            isPaused = false;
            isDeleting = true;
            setTimeout(tick, 50);
            return;
        }

        if (!isDeleting) {
            el.textContent = current.slice(0, charIndex + 1);
            charIndex++;

            if (charIndex === current.length) {
                isPaused = true;
                setTimeout(tick, 2000);
                return;
            }
            setTimeout(tick, 50 + Math.random() * 40);
        } else {
            el.textContent = current.slice(0, charIndex - 1);
            charIndex--;

            if (charIndex === 0) {
                isDeleting = false;
                phraseIndex = (phraseIndex + 1) % phrases.length;
                setTimeout(tick, 400);
                return;
            }
            setTimeout(tick, 25);
        }
    }

    setTimeout(tick, 800);
}

// ===================== Counter Animation =====================
function animateCounters() {
    const counters = document.querySelectorAll('.stat-number[data-target]');
    counters.forEach(counter => {
        if (counter.dataset.animated) return;

        const target = parseInt(counter.dataset.target, 10);
        if (isNaN(target)) return;

        counter.dataset.animated = 'true';
        const duration = 1200;
        const start = performance.now();

        function update(now) {
            const elapsed = now - start;
            const progress = Math.min(elapsed / duration, 1);
            const eased = 1 - Math.pow(1 - progress, 3);
            counter.textContent = Math.round(eased * target);

            if (progress < 1) {
                requestAnimationFrame(update);
            } else {
                counter.textContent = target;
            }
        }

        requestAnimationFrame(update);
    });
}

// ===================== Mobile Navigation Toggle =====================
const navToggle = document.getElementById('navToggle');
const navMenu = document.getElementById('navMenu');
const navLinks = document.querySelectorAll('.nav-link');

navToggle.addEventListener('click', () => {
    const isActive = navToggle.classList.toggle('active');
    navMenu.classList.toggle('active');
    navToggle.setAttribute('aria-expanded', isActive);
});

navToggle.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        navToggle.click();
    }
});

navLinks.forEach(link => {
    link.addEventListener('click', () => {
        navToggle.classList.remove('active');
        navMenu.classList.remove('active');
        navToggle.setAttribute('aria-expanded', 'false');
    });
});

// ===================== Navbar Scroll State =====================
const navbar = document.querySelector('.navbar');

function updateNavbar() {
    navbar.classList.toggle('scrolled', window.scrollY > 20);
}

window.addEventListener('scroll', updateNavbar, { passive: true });

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
        link.classList.toggle('active', link.getAttribute('href') === `#${current}`);
    });
}

window.addEventListener('scroll', updateActiveLink, { passive: true });

// ===================== Scroll Indicator =====================
const scrollIndicator = document.querySelector('.scroll-indicator');

if (scrollIndicator) {
    window.addEventListener('scroll', () => {
        scrollIndicator.style.opacity = window.scrollY > window.innerHeight * 0.8 ? '0' : '1';
    }, { passive: true });
}

// ===================== Intersection Observer =====================
const observerOptions = {
    threshold: 0.1,
    rootMargin: '0px 0px -60px 0px'
};

const observer = new IntersectionObserver((entries) => {
    entries.forEach(entry => {
        if (entry.isIntersecting) {
            entry.target.classList.add('visible');

            if (entry.target.closest('.github-stats')) {
                animateCounters();
            }

            observer.unobserve(entry.target);
        }
    });
}, observerOptions);

const animatedElements = document.querySelectorAll(
    '.about-card, .project-featured, .skill-category, .stat-card, .contact-item, .stack-highlight'
);

animatedElements.forEach(el => {
    el.classList.add('reveal');
    observer.observe(el);
});

function staggerChildren(parentSelector) {
    const parents = document.querySelectorAll(parentSelector);
    parents.forEach(parent => {
        const children = parent.querySelectorAll('.about-card, .skill-category');
        children.forEach((child, i) => {
            child.style.transitionDelay = `${i * 80}ms`;
            child.classList.add('reveal-stagger');
            observer.observe(child);
        });
    });
}

staggerChildren('.about-grid');
staggerChildren('.skills-grid');

// ===================== Parallax Effect =====================
const heroBg = document.querySelector('.hero-bg');

if (heroBg && window.innerWidth > 768) {
    window.addEventListener('mousemove', (e) => {
        const x = (e.clientX / window.innerWidth - 0.5) * 20;
        const y = (e.clientY / window.innerHeight - 0.5) * 20;
        heroBg.style.transform = `translate(${x}px, ${y}px)`;
    }, { passive: true });
}

// ===================== Init =====================
document.addEventListener('DOMContentLoaded', () => {
    initTypingEffect();
    fetchLatestRelease();
    RepoManager.init();
    updateNavbar();
    updateActiveLink();
});
