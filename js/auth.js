/**
 * Crimson & Quill - Portal Authentication Client Logic
 */
var CQAuth = (function () {
  'use strict';

  // Get CSRF token from cookie
  function getCSRFToken() {
    var cookies = document.cookie.split(';');
    for (var i = 0; i < cookies.length; i++) {
      var cookie = cookies[i].trim();
      if (cookie.startsWith('cq_csrf=')) {
        return cookie.substring('cq_csrf='.length);
      }
    }
    return '';
  }

  // Get portal type from URL params
  function getPortalType() {
    var params = new URLSearchParams(window.location.search);
    return params.get('type') === 'staff' ? 'staff' : 'client';
  }

  // Get stored email from sessionStorage
  function getStoredEmail() {
    return sessionStorage.getItem('cq_login_email') || '';
  }

  // Show error message
  function showError(el, msg) {
    el.textContent = msg;
    el.classList.add('visible');
  }

  function hideError(el) {
    el.classList.remove('visible');
  }

  // Set button loading state
  function setLoading(btn, loading) {
    if (loading) {
      btn.classList.add('loading');
      btn.disabled = true;
    } else {
      btn.classList.remove('loading');
      btn.disabled = false;
    }
  }

  /**
   * Initialize the login page
   */
  function initLogin() {
    var portalType = getPortalType();
    var badge = document.getElementById('portalBadge');
    var heading = document.getElementById('heading');
    var form = document.getElementById('loginForm');
    var emailInput = document.getElementById('email');
    var submitBtn = document.getElementById('submitBtn');
    var errorMsg = document.getElementById('errorMsg');

    // Set portal type styling
    if (portalType === 'staff') {
      badge.textContent = 'Staff Portal';
      badge.classList.add('staff');
      heading.textContent = 'Staff Portal Sign In';
    } else {
      badge.textContent = 'Client Portal';
      badge.classList.add('client');
      heading.textContent = 'Client Portal Sign In';
    }

    // Pre-fill email if returning
    var stored = getStoredEmail();
    if (stored) {
      emailInput.value = stored;
    }

    // Form submit handler
    form.addEventListener('submit', function (e) {
      e.preventDefault();
      hideError(errorMsg);

      var email = emailInput.value.trim().toLowerCase();
      if (!email) {
        showError(errorMsg, 'Please enter your email address.');
        return;
      }

      setLoading(submitBtn, true);

      var csrfToken = getCSRFToken();
      fetch('/api/request-otp', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-CSRF-Token': csrfToken,
        },
        body: JSON.stringify({ email: email, portalType: portalType }),
      })
        .then(function (res) { return res.json().then(function (data) { return { ok: res.ok, data: data }; }); })
        .then(function (result) {
          setLoading(submitBtn, false);
          if (result.ok && result.data.success) {
            // Store email, otpToken, and redirect to OTP page
            sessionStorage.setItem('cq_login_email', email);
            sessionStorage.setItem('cq_portal_type', portalType);
            if (result.data.otpToken) {
              sessionStorage.setItem('cq_otp_token', result.data.otpToken);
            }
            window.location.href = '/verify-otp?type=' + portalType;
          } else {
            showError(errorMsg, result.data.error || 'Something went wrong. Please try again.');
          }
        })
        .catch(function () {
          setLoading(submitBtn, false);
          showError(errorMsg, 'Unable to connect. Please check your internet and try again.');
        });
    });
  }

  /**
   * Initialize the OTP verification page
   */
  function initVerify() {
    var portalType = getPortalType();
    var email = getStoredEmail();
    var emailDisplay = document.getElementById('emailDisplay');
    var form = document.getElementById('otpForm');
    var verifyBtn = document.getElementById('verifyBtn');
    var errorMsg = document.getElementById('errorMsg');
    var successMsg = document.getElementById('successMsg');
    var resendLink = document.getElementById('resendLink');
    var resendTimer = document.getElementById('resendTimer');
    var changeEmail = document.getElementById('changeEmail');
    var inputs = document.querySelectorAll('#otpInputs input');

    // If no email stored, redirect back to login
    if (!email) {
      window.location.href = '/login?type=' + portalType;
      return;
    }

    // Set display
    emailDisplay.textContent = email;
    changeEmail.href = '/login?type=' + portalType;

    // OTP input behavior
    inputs.forEach(function (input, index) {
      input.addEventListener('input', function (e) {
        var val = e.target.value.replace(/[^0-9]/g, '');
        e.target.value = val;

        if (val) {
          e.target.classList.add('filled');
          if (index < inputs.length - 1) {
            inputs[index + 1].focus();
          }
        } else {
          e.target.classList.remove('filled');
        }

        // Enable/disable verify button
        checkOTPComplete();
      });

      input.addEventListener('keydown', function (e) {
        if (e.key === 'Backspace' && !e.target.value && index > 0) {
          inputs[index - 1].focus();
          inputs[index - 1].value = '';
          inputs[index - 1].classList.remove('filled');
          checkOTPComplete();
        }
      });

      // Handle paste
      input.addEventListener('paste', function (e) {
        e.preventDefault();
        var pasted = (e.clipboardData || window.clipboardData).getData('text').replace(/[^0-9]/g, '');
        if (pasted.length >= 6) {
          for (var i = 0; i < 6; i++) {
            inputs[i].value = pasted[i];
            inputs[i].classList.add('filled');
          }
          inputs[5].focus();
          checkOTPComplete();
        }
      });
    });

    function checkOTPComplete() {
      var code = getOTPValue();
      verifyBtn.disabled = code.length !== 6;
    }

    function getOTPValue() {
      var code = '';
      inputs.forEach(function (input) { code += input.value; });
      return code;
    }

    // Form submit
    form.addEventListener('submit', function (e) {
      e.preventDefault();
      hideError(errorMsg);
      var code = getOTPValue();
      if (code.length !== 6) return;

      setLoading(verifyBtn, true);

      var csrfToken = getCSRFToken();
      var storedOTPToken = sessionStorage.getItem('cq_otp_token') || '';
      fetch('/api/verify-otp', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-CSRF-Token': csrfToken,
        },
        body: JSON.stringify({ email: email, code: code, portalType: portalType, otpToken: storedOTPToken }),
      })
        .then(function (res) { return res.json().then(function (data) { return { ok: res.ok, data: data }; }); })
        .then(function (result) {
          setLoading(verifyBtn, false);
          if (result.ok && result.data.success) {
            // Show success briefly, then redirect
            successMsg.textContent = 'Verified! Redirecting to your portal...';
            successMsg.classList.add('visible');
            form.style.display = 'none';

            // Clean up session storage
            sessionStorage.removeItem('cq_login_email');
            sessionStorage.removeItem('cq_portal_type');
            sessionStorage.removeItem('cq_otp_token');

            setTimeout(function () {
              window.location.href = result.data.redirectUrl;
            }, 1200);
          } else {
            showError(errorMsg, result.data.error || 'Verification failed. Please try again.');
            // Clear inputs on error
            inputs.forEach(function (input) {
              input.value = '';
              input.classList.remove('filled');
            });
            inputs[0].focus();
            verifyBtn.disabled = true;
          }
        })
        .catch(function () {
          setLoading(verifyBtn, false);
          showError(errorMsg, 'Unable to connect. Please check your internet and try again.');
        });
    });

    // Resend code cooldown (60 seconds) - persisted in sessionStorage
    var resendCooldown = 60;
    var resendInterval = null;
    var COOLDOWN_MS = 60000; // 60 seconds

    function startResendTimer() {
      resendCooldown = 60;
      resendLink.classList.add('disabled');
      resendTimer.textContent = ' (' + resendCooldown + 's)';
      resendTimer.style.display = '';

      // Store cooldown end time in sessionStorage
      sessionStorage.setItem('otpCooldownEnd', Date.now() + COOLDOWN_MS);

      resendInterval = setInterval(function () {
        resendCooldown--;
        if (resendCooldown <= 0) {
          clearInterval(resendInterval);
          resendLink.classList.remove('disabled');
          resendTimer.style.display = 'none';
          sessionStorage.removeItem('otpCooldownEnd');
        } else {
          resendTimer.textContent = ' (' + resendCooldown + 's)';
        }
      }, 1000);
    }

    function resumeResendTimer() {
      var cooldownEnd = parseInt(sessionStorage.getItem('otpCooldownEnd') || '0');
      var now = Date.now();
      if (cooldownEnd && now < cooldownEnd) {
        // Cooldown still active, resume it
        resendLink.classList.add('disabled');
        resendTimer.style.display = '';

        resendInterval = setInterval(function () {
          var remaining = Math.ceil((cooldownEnd - Date.now()) / 1000);
          if (remaining <= 0) {
            clearInterval(resendInterval);
            resendLink.classList.remove('disabled');
            resendTimer.style.display = 'none';
            sessionStorage.removeItem('otpCooldownEnd');
          } else {
            resendTimer.textContent = ' (' + remaining + 's)';
          }
        }, 1000);
      }
    }

    // Check if cooldown is still active on page load
    resumeResendTimer();

    // If no cooldown active, start initial cooldown
    if (!sessionStorage.getItem('otpCooldownEnd')) {
      startResendTimer();
    }

    // Resend click
    resendLink.addEventListener('click', function (e) {
      e.preventDefault();
      if (resendLink.classList.contains('disabled')) return;

      hideError(errorMsg);
      resendLink.textContent = 'Sending...';

      var csrfToken = getCSRFToken();
      fetch('/api/request-otp', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-CSRF-Token': csrfToken,
        },
        body: JSON.stringify({ email: email, portalType: portalType }),
      })
        .then(function (res) { return res.json().then(function (data) { return { ok: res.ok, data: data }; }); })
        .then(function (result) {
          resendLink.textContent = 'Resend Code';
          if (result.ok) {
            // Store new otpToken from resend response
            if (result.data.otpToken) {
              sessionStorage.setItem('cq_otp_token', result.data.otpToken);
            }
            successMsg.textContent = 'A new code has been sent to your email.';
            successMsg.classList.add('visible');
            setTimeout(function () { successMsg.classList.remove('visible'); }, 4000);
            startResendTimer();
          } else {
            showError(errorMsg, result.data.error || 'Failed to resend code.');
          }
        })
        .catch(function () {
          resendLink.textContent = 'Resend Code';
          showError(errorMsg, 'Unable to connect. Please try again.');
        });
    });
  }

  return {
    initLogin: initLogin,
    initVerify: initVerify,
  };
})();
