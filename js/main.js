// ============================================
// CRIMSON & QUILL - MAIN JAVASCRIPT
// ============================================

document.addEventListener('DOMContentLoaded', function() {
  // Initialize all components
  initHeader();
  initMobileMenu();
  initScrollTop();
  initSmoothScroll();
  initAnimations();
  initSectionDividers();
  initForms();
});

// ============================================
// HEADER - Scroll behavior
// ============================================
function initHeader() {
  const header = document.querySelector('.header');
  if (!header) return;

  let lastScroll = 0;

  window.addEventListener('scroll', () => {
    const currentScroll = window.pageYOffset;

    // Add shadow when scrolled
    if (currentScroll > 10) {
      header.classList.add('scrolled');
    } else {
      header.classList.remove('scrolled');
    }

    lastScroll = currentScroll;
  });
}

// ============================================
// MOBILE MENU
// ============================================
function initMobileMenu() {
  const menuToggle = document.querySelector('.menu-toggle');
  const navLinks = document.querySelector('.nav-links');
  const body = document.body;

  if (!menuToggle || !navLinks) return;

  menuToggle.addEventListener('click', () => {
    navLinks.classList.toggle('active');
    menuToggle.classList.toggle('active');
    body.classList.toggle('menu-open');
  });

  // Close menu when clicking a link
  navLinks.querySelectorAll('a').forEach(link => {
    link.addEventListener('click', () => {
      navLinks.classList.remove('active');
      menuToggle.classList.remove('active');
      body.classList.remove('menu-open');
    });
  });

  // Close menu when clicking outside
  document.addEventListener('click', (e) => {
    if (!navLinks.contains(e.target) && !menuToggle.contains(e.target)) {
      navLinks.classList.remove('active');
      menuToggle.classList.remove('active');
      body.classList.remove('menu-open');
    }
  });
}

// ============================================
// SCROLL TO TOP BUTTON
// ============================================
function initScrollTop() {
  const scrollTopBtn = document.querySelector('.scroll-top');
  if (!scrollTopBtn) return;

  window.addEventListener('scroll', () => {
    if (window.pageYOffset > 300) {
      scrollTopBtn.classList.add('visible');
    } else {
      scrollTopBtn.classList.remove('visible');
    }
  });

  scrollTopBtn.addEventListener('click', () => {
    window.scrollTo({
      top: 0,
      behavior: 'smooth'
    });
  });
}

// ============================================
// SMOOTH SCROLL
// ============================================
function initSmoothScroll() {
  document.querySelectorAll('a[href^="#"]').forEach(anchor => {
    anchor.addEventListener('click', function(e) {
      const href = this.getAttribute('href');
      if (href === '#') return;

      e.preventDefault();
      const target = document.querySelector(href);
      if (target) {
        const headerHeight = document.querySelector('.header')?.offsetHeight || 0;
        const targetPosition = target.getBoundingClientRect().top + window.pageYOffset - headerHeight;

        window.scrollTo({
          top: targetPosition,
          behavior: 'smooth'
        });
      }
    });
  });
}

// ============================================
// SCROLL ANIMATIONS — Revolut-style dramatic reveals
// translateY(75px) → 0, 350ms, cubic-bezier(0.35,0,0,1)
// ============================================
function initAnimations() {
  // Revolut easing & timing
  const EASE = 'cubic-bezier(0.35, 0, 0, 1)';
  const DUR  = '600ms';           // slightly longer for drama
  const STAGGER = 120;            // ms between siblings
  const TRANSLATE = '75px';       // Revolut uses 75px

  // Inject animation CSS
  const style = document.createElement('style');
  style.id = 'revolut-anim';
  style.textContent = `
    .rv-hidden {
      opacity: 0;
      transform: translateY(${TRANSLATE});
      will-change: transform, opacity;
    }
    .rv-visible {
      opacity: 1 !important;
      transform: translateY(0) !important;
      transition: transform ${DUR} ${EASE}, opacity ${DUR} ${EASE} !important;
    }
    /* Hero gets a special entrance — fade + slight scale */
    .hero .rv-hidden,
    .hero [data-animate] {
      opacity: 0;
      transform: translateY(40px) scale(0.98);
    }
    .hero .rv-visible {
      opacity: 1 !important;
      transform: translateY(0) scale(1) !important;
      transition: transform 800ms ${EASE}, opacity 800ms ${EASE} !important;
    }
    /* Cards get a subtle scale on reveal */
    .card.rv-hidden,
    .feature-card.rv-hidden,
    .practice-card.rv-hidden,
    .team-card.rv-hidden,
    .insight-card.rv-hidden {
      transform: translateY(60px) scale(0.97);
    }
    .card.rv-visible,
    .feature-card.rv-visible,
    .practice-card.rv-visible,
    .team-card.rv-visible,
    .insight-card.rv-visible {
      transform: translateY(0) scale(1) !important;
    }
    /* Buttons slide up from further */
    .btn.rv-hidden { transform: translateY(30px); }
    /* Section labels/small text fade in gently */
    .label.rv-hidden,
    .section-label.rv-hidden {
      transform: translateY(20px);
    }
    /* Parallax-feel for large images */
    img.rv-hidden,
    picture.rv-hidden {
      transform: translateY(50px) scale(0.99);
    }
    img.rv-visible,
    picture.rv-visible {
      transform: translateY(0) scale(1) !important;
    }
  `;
  document.head.appendChild(style);

  // Auto-detect animatable elements (no manual data-animate needed)
  const SELECTORS = [
    '[data-animate]',
    '.hero-content',
    '.hero h1',
    '.hero p',
    '.hero .btn',
    '.hero-label',
    '.section-header',
    '.section-header h2',
    '.section-header p',
    '.section .label',
    '.card',
    '.feature-card',
    '.practice-card',
    '.team-card',
    '.insight-card',
    '.quote-block',
    '.cta-section h2',
    '.cta-section p',
    '.cta-section .btn',
    '.page-hero h1',
    '.page-hero .lead',
    '.page-hero .label',
    '.content-section > *',
    '.contact-form',
    '.contact-info',
    '.form-group',
    '.team-member',
    '.grid > *',
    '.values-grid > *',
    '.features-grid > *',
    '.practice-grid > *',
    '.team-grid > *',
    '.insights-grid > *',
    '.careers-grid > *',
    '.process-steps > *',
    '.legal-section',
    '.footer-grid > *',
    'img[src]',
    'picture'
  ].join(',');

  const elements = document.querySelectorAll(SELECTORS);
  if (elements.length === 0) return;

  // Skip elements inside hero for separate hero handling
  const heroEl = document.querySelector('.hero');

  // Mark all elements as hidden
  elements.forEach(el => {
    // Don't double-animate nested elements
    if (el.closest('.rv-hidden') && el !== el.closest('.rv-hidden')) return;
    // Skip very small or invisible elements
    if (el.offsetHeight === 0 && !el.closest('.hero')) return;
    el.classList.add('rv-hidden');
  });

  // Hero elements animate immediately on load with stagger
  if (heroEl) {
    const heroChildren = heroEl.querySelectorAll('.rv-hidden');
    heroChildren.forEach((el, i) => {
      setTimeout(() => {
        el.classList.add('rv-visible');
      }, 200 + (i * STAGGER));
    });
  }

  // IntersectionObserver for everything else
  const observer = new IntersectionObserver((entries) => {
    // Group entries that fire together (same scroll tick)
    const appearing = entries.filter(e => e.isIntersecting);
    if (appearing.length === 0) return;

    appearing.forEach((entry, i) => {
      // Stagger siblings that appear together
      const delay = i * STAGGER;
      setTimeout(() => {
        entry.target.classList.add('rv-visible');
      }, delay);
      observer.unobserve(entry.target);
    });
  }, {
    threshold: 0.08,
    rootMargin: '0px 0px -60px 0px'   // trigger slightly before fully in view
  });

  // Observe non-hero elements
  document.querySelectorAll('.rv-hidden').forEach(el => {
    if (heroEl && heroEl.contains(el)) return;  // hero handled above
    observer.observe(el);
  });

  // Cleanup: reveal anything still hidden after 5s (safety net)
  setTimeout(() => {
    document.querySelectorAll('.rv-hidden:not(.rv-visible)').forEach(el => {
      el.classList.add('rv-visible');
    });
  }, 5000);
}

// ============================================
// SECTION DIVIDERS — gold line grows on scroll
// ============================================
function initSectionDividers() {
  const sections = document.querySelectorAll('.section');
  if (sections.length < 2) return;

  const sectionObserver = new IntersectionObserver((entries) => {
    entries.forEach(entry => {
      if (entry.isIntersecting) {
        entry.target.classList.add('rv-section-visible');
      }
    });
  }, { threshold: 0.15 });

  sections.forEach(s => sectionObserver.observe(s));
}

// ============================================
// FORM HANDLING
// ============================================
function initForms() {
  const contactForm = document.querySelector('#contact-form');
  if (!contactForm) return;

  contactForm.addEventListener('submit', async (e) => {
    e.preventDefault();

    const submitBtn = contactForm.querySelector('button[type="submit"]');
    const originalText = submitBtn.textContent;

    // Show loading state
    submitBtn.disabled = true;
    submitBtn.textContent = 'Sending...';

    // Simulate form submission (replace with actual endpoint)
    try {
      // In production, you would send to your form endpoint
      await new Promise(resolve => setTimeout(resolve, 1500));

      // Show success message
      showNotification('Thank you! Your message has been sent. We will respond within 1-2 business days.', 'success');
      contactForm.reset();
    } catch (error) {
      showNotification('Something went wrong. Please try again or email us directly.', 'error');
    } finally {
      submitBtn.disabled = false;
      submitBtn.textContent = originalText;
    }
  });

  // Newsletter form
  const newsletterForm = document.querySelector('#newsletter-form');
  if (newsletterForm) {
    newsletterForm.addEventListener('submit', async (e) => {
      e.preventDefault();

      const email = newsletterForm.querySelector('input[type="email"]').value;
      const submitBtn = newsletterForm.querySelector('button[type="submit"]');

      submitBtn.disabled = true;
      submitBtn.textContent = 'Subscribing...';

      try {
        await new Promise(resolve => setTimeout(resolve, 1000));
        showNotification('Thank you for subscribing!', 'success');
        newsletterForm.reset();
      } catch (error) {
        showNotification('Subscription failed. Please try again.', 'error');
      } finally {
        submitBtn.disabled = false;
        submitBtn.textContent = 'Subscribe';
      }
    });
  }
}

// ============================================
// NOTIFICATION SYSTEM
// ============================================
function showNotification(message, type = 'info') {
  // Remove existing notifications
  const existingNotification = document.querySelector('.notification');
  if (existingNotification) {
    existingNotification.remove();
  }

  // Create notification element
  const notification = document.createElement('div');
  notification.className = `notification notification-${type}`;
  notification.innerHTML = `
    <p>${message}</p>
    <button class="notification-close">&times;</button>
  `;

  // Add styles
  notification.style.cssText = `
    position: fixed;
    top: 100px;
    right: 20px;
    max-width: 400px;
    padding: 16px 20px;
    background: ${type === 'success' ? '#10B981' : type === 'error' ? '#EF4444' : '#3B82F6'};
    color: white;
    border-radius: 8px;
    box-shadow: 0 10px 25px rgba(0,0,0,0.15);
    display: flex;
    align-items: center;
    gap: 12px;
    z-index: 9999;
    animation: slideIn 0.3s ease;
  `;

  // Add animation keyframes
  if (!document.querySelector('#notification-styles')) {
    const style = document.createElement('style');
    style.id = 'notification-styles';
    style.textContent = `
      @keyframes slideIn {
        from { transform: translateX(100%); opacity: 0; }
        to { transform: translateX(0); opacity: 1; }
      }
      .notification p { margin: 0; flex: 1; }
      .notification-close {
        background: none;
        border: none;
        color: white;
        font-size: 24px;
        cursor: pointer;
        padding: 0;
        line-height: 1;
      }
    `;
    document.head.appendChild(style);
  }

  document.body.appendChild(notification);

  // Close button
  notification.querySelector('.notification-close').addEventListener('click', () => {
    notification.remove();
  });

  // Auto-remove after 5 seconds
  setTimeout(() => {
    if (notification.parentNode) {
      notification.remove();
    }
  }, 5000);
}

// ============================================
// DROPDOWN MENUS (Desktop)
// ============================================
function initDropdowns() {
  const dropdowns = document.querySelectorAll('.nav-item.has-dropdown');

  dropdowns.forEach(dropdown => {
    const trigger = dropdown.querySelector('.nav-link');
    const menu = dropdown.querySelector('.nav-dropdown');

    if (!trigger || !menu) return;

    // For touch devices
    trigger.addEventListener('click', (e) => {
      if (window.innerWidth <= 1024) {
        e.preventDefault();
        menu.classList.toggle('active');
      }
    });
  });
}

// ============================================
// ACTIVE NAV LINK
// ============================================
function setActiveNavLink() {
  const currentPath = window.location.pathname;
  const navLinks = document.querySelectorAll('.nav-link');

  navLinks.forEach(link => {
    const href = link.getAttribute('href');
    if (href === currentPath || (currentPath === '/' && href === 'index.html')) {
      link.classList.add('active');
    }
  });
}

// Run on page load
setActiveNavLink();

// ============================================
// LAZY LOADING IMAGES
// ============================================
function initLazyLoading() {
  const lazyImages = document.querySelectorAll('img[data-src]');

  if ('IntersectionObserver' in window) {
    const imageObserver = new IntersectionObserver((entries) => {
      entries.forEach(entry => {
        if (entry.isIntersecting) {
          const img = entry.target;
          img.src = img.dataset.src;
          img.removeAttribute('data-src');
          imageObserver.unobserve(img);
        }
      });
    });

    lazyImages.forEach(img => imageObserver.observe(img));
  } else {
    // Fallback for older browsers
    lazyImages.forEach(img => {
      img.src = img.dataset.src;
    });
  }
}

// Initialize lazy loading
initLazyLoading();
