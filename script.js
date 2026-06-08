// ===================== Mobile Navigation Toggle =====================
const navToggle = document.getElementById('navToggle');
const navMenu = document.getElementById('navMenu');
const navLinks = document.querySelectorAll('.nav-link');

navToggle.addEventListener('click', () => {
    navToggle.classList.toggle('active');
    navMenu.classList.toggle('active');
});

// Close mobile menu on link click
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

// Observe all cards and sections
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

// ===================== GitHub Release Version Auto-Fetcher =====================
async function fetchLatestVersion() {
    const versionElements = document.querySelectorAll('[data-repo]');
    if (versionElements.length === 0) return;

    // Use the first element's repo attribute
    const repo = versionElements[0].getAttribute('data-repo');

    try {
        const response = await fetch(`https://api.github.com/repos/${repo}/releases/latest`);
        if (!response.ok) throw new Error(`GitHub API error: ${response.status}`);
        const data = await response.json();
        const tagName = data.tag_name; // e.g. "v0.1.1"

        // Update all version-tag elements with the matching repo
        document.querySelectorAll(`.version-tag[data-repo="${repo}"]`).forEach(el => {
            el.textContent = tagName;
        });

        // Also update the release banner version
        const releaseVersionEl = document.querySelector('.release-version');
        if (releaseVersionEl) {
            releaseVersionEl.textContent = tagName;
        }
    } catch (err) {
        console.warn('Failed to fetch latest release version:', err);
        // Keep the initial hardcoded version as fallback
    }
}

// Fetch latest version on page load
document.addEventListener('DOMContentLoaded', fetchLatestVersion);

// ===================== Parallax effect on hero background =====================
const heroBg = document.querySelector('.hero-bg');

window.addEventListener('mousemove', (e) => {
    if (window.innerWidth > 768 && heroBg) {
        const x = (e.clientX / window.innerWidth - 0.5) * 20;
        const y = (e.clientY / window.innerHeight - 0.5) * 20;
        heroBg.style.transform = `translate(${x}px, ${y}px)`;
    }
});