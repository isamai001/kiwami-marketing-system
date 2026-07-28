document.addEventListener('DOMContentLoaded', async function () {
    // Check if the browser already has a valid server-side session cookie
    let isLoggedIn = sessionStorage.getItem('isLoggedIn') === 'true';
    if (!isLoggedIn) {
        try {
            const response = await fetch('/api/login-status', { method: 'GET', cache: 'no-store' });
            isLoggedIn = response.ok;
        } catch {
            isLoggedIn = false;
        }
    }

    if (isLoggedIn) {
        sessionStorage.setItem('isLoggedIn', 'true');
        initializeApp();
    } else {
        // Set up login functionality
        document.getElementById('login-btn').addEventListener('click', async function () {
            const email = document.getElementById('login-email').value.trim();
            const password = document.getElementById('login-password').value;

            if (!email || !password) {
                alert('Please enter both email and password.');
                return;
            }

            const loginBtn = document.getElementById('login-btn');
            loginBtn.disabled = true;
            loginBtn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Signing in...';

            try {
                const response = await fetch('/api/login', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ email, password })
                });

                const data = await response.json();
                if (!response.ok) {
                    throw new Error(data.error || 'Login failed');
                }

                sessionStorage.setItem('isLoggedIn', 'true');
                document.documentElement.classList.remove('logged-out');
                document.documentElement.classList.add('logged-in');
                initializeApp();
            } catch (error) {
                alert(error.message || 'Invalid credentials. Please try again.');
            } finally {
                loginBtn.disabled = false;
                loginBtn.innerHTML = '<i class="fas fa-sign-in-alt"></i> Login';
            }
        });

        // Password visibility toggle
        document.getElementById('toggle-password').addEventListener('click', function () {
            const pwdInput = document.getElementById('login-password');
            const icon = document.getElementById('toggle-password-icon');
            if (pwdInput.type === 'password') {
                pwdInput.type = 'text';
                icon.classList.remove('fa-eye');
                icon.classList.add('fa-eye-slash');
            } else {
                pwdInput.type = 'password';
                icon.classList.remove('fa-eye-slash');
                icon.classList.add('fa-eye');
            }
        });

        // Allow Enter key on login form
        document.getElementById('login-password').addEventListener('keydown', function (e) {
            if (e.key === 'Enter') document.getElementById('login-btn').click();
        });
        document.getElementById('login-email').addEventListener('keydown', function (e) {
            if (e.key === 'Enter') document.getElementById('login-btn').click();
        });
    }

    function initializeApp() {
        // Load content from localStorage or use sample data
        let contentItems = JSON.parse(localStorage.getItem('contentItems')) || [];
        let topics = JSON.parse(localStorage.getItem('topics')) || [
            { id: 'general', name: 'General Technology', icon: 'fa-microchip' },
            { id: 'qa', name: 'Software Testing / QA', icon: 'fa-bug' },
            { id: 'ai', name: 'AI Updates', icon: 'fa-robot' }
        ];

        let currentContentId = null;
        let currentDate = new Date();
        let currentMedia = null;
        let currentMediaType = null; // 'image' or 'video'
        let currentMediaFile = null;
        let activeTopicFilter = 'all';
        let selectedPlatform = null;

        // Media processing helper functions
        function isVideoMedia(url, type) {
            if (type === 'video') return true;
            if (type === 'image') return false;
            if (!url) return false;
            if (typeof url === 'string') {
                if (url.startsWith('data:video/')) return true;
                const clean = url.split('?')[0].toLowerCase();
                return /\.(mp4|webm|mov|avi|mkv|ogg)$/.test(clean);
            }
            return false;
        }

        function formatBytes(bytes) {
            if (!bytes || isNaN(bytes)) return '';
            if (bytes >= 1024 * 1024) return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
            if (bytes >= 1024) return (bytes / 1024).toFixed(1) + ' KB';
            return bytes + ' B';
        }

        function displayMediaPreview(mediaUrl, mediaType, fileName = '', fileSize = null) {
            const container = document.getElementById('media-preview-container');
            const infoBadge = document.getElementById('media-file-info');
            const imgEl = document.getElementById('media-preview-img');
            const videoEl = document.getElementById('media-preview-video');
            const removeBtn = document.getElementById('remove-media');

            if (!mediaUrl) {
                if (container) container.style.display = 'none';
                if (imgEl) { imgEl.style.display = 'none'; imgEl.src = ''; }
                if (videoEl) { videoEl.style.display = 'none'; videoEl.src = ''; }
                if (removeBtn) removeBtn.style.display = 'none';
                return;
            }

            const isVid = isVideoMedia(mediaUrl, mediaType);
            currentMediaType = isVid ? 'video' : 'image';

            if (infoBadge) {
                const iconClass = isVid ? 'fa-file-video' : 'fa-file-image';
                const typeLabel = isVid ? 'Video' : 'Image';
                const sizeStr = fileSize ? ` (${formatBytes(fileSize)})` : '';
                const nameStr = fileName ? fileName : 'Attached Media';
                infoBadge.innerHTML = `<i class="fas ${iconClass}" style="color:var(--primary);"></i> <span>${typeLabel}: ${nameStr}${sizeStr}</span>`;
            }

            if (isVid) {
                if (imgEl) { imgEl.style.display = 'none'; imgEl.src = ''; }
                if (videoEl) { videoEl.src = mediaUrl; videoEl.style.display = 'block'; }
            } else {
                if (videoEl) { videoEl.style.display = 'none'; videoEl.src = ''; }
                if (imgEl) { imgEl.src = mediaUrl; imgEl.style.display = 'block'; }
            }

            if (container) container.style.display = 'block';
            if (removeBtn) removeBtn.style.display = 'flex';
        }

        async function processMediaFile(file) {
            if (!file) return;

            if (file.size > 100 * 1024 * 1024) {
                showToast('File size must be less than 100MB', true);
                return;
            }

            currentMediaFile = file;
            const isVid = file.type.startsWith('video/');
            currentMediaType = isVid ? 'video' : 'image';

            const progressBar = document.getElementById('upload-progress');
            const progressBarInner = document.getElementById('upload-progress-bar');
            if (progressBar) progressBar.style.display = 'block';
            if (progressBarInner) progressBarInner.style.width = '15%';

            const reader = new FileReader();
            reader.onprogress = (e) => {
                if (e.lengthComputable && progressBarInner) {
                    const percent = Math.round(15 + (e.loaded / e.total) * 55);
                    progressBarInner.style.width = `${percent}%`;
                }
            };

            reader.onload = async (e) => {
                const dataUrl = e.target.result;
                if (progressBarInner) progressBarInner.style.width = '85%';

                let finalMediaUrl = dataUrl;

                try {
                    const response = await fetch('/api/upload', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({
                            fileName: file.name,
                            fileType: file.type,
                            fileData: dataUrl
                        })
                    });

                    if (response.ok) {
                        const resData = await response.json();
                        if (resData.url) {
                            finalMediaUrl = resData.url;
                        }
                    }
                } catch (err) {
                    console.log('Server upload offline, using Data URL:', err);
                }

                if (progressBarInner) progressBarInner.style.width = '100%';

                setTimeout(() => {
                    if (progressBar) progressBar.style.display = 'none';
                    if (progressBarInner) progressBarInner.style.width = '0%';
                    currentMedia = finalMediaUrl;
                    displayMediaPreview(currentMedia, currentMediaType, file.name, file.size);
                    showToast(`${isVid ? 'Video' : 'Image'} uploaded successfully!`);
                }, 300);
            };

            reader.onerror = (err) => {
                if (progressBar) progressBar.style.display = 'none';
                showToast('Error reading media file', true);
                console.error('FileReader error:', err);
            };

            reader.readAsDataURL(file);
        }

        // Initialize analytics charts
        let performanceChart, platformChart, audienceChart;
        initializeCharts();

        // Initialize the application
        renderCalendar(currentDate);
        renderTopics();
        populateTopicDropdown();
        setupManualStatsInputs();
        setupPlatformMetrics();

        // Set up event listeners
        setupEventListeners();

        // Check for daily notifications
        checkDailyNotifications();

        // Function to initialize charts (empty until data is fetched)
        function initializeCharts() {
            const ctx1 = document.getElementById('performance-chart').getContext('2d');
            performanceChart = new Chart(ctx1, {
                type: 'line',
                data: {
                    labels: [],
                    datasets: [{
                        label: 'Engagement Rate',
                        data: [],
                        borderColor: '#3498db',
                        tension: 0.1,
                        fill: false
                    }, {
                        label: 'Follower Growth (K)',
                        data: [],
                        borderColor: '#2ecc71',
                        tension: 0.1,
                        fill: false
                    }]
                },
                options: {
                    responsive: true,
                    maintainAspectRatio: false,
                    plugins: {
                        title: {
                            display: true,
                            text: 'Performance Trends'
                        },
                        legend: { display: true }
                    }
                }
            });

            const ctx2 = document.getElementById('platform-chart').getContext('2d');
            platformChart = new Chart(ctx2, {
                type: 'doughnut',
                data: {
                    labels: ['Facebook', 'Instagram', 'Twitter', 'LinkedIn', 'YouTube', 'TikTok'],
                    datasets: [{
                        data: [0, 0, 0, 0, 0, 0],
                        backgroundColor: [
                            '#3b5998',
                            '#e4405f',
                            '#1da1f2',
                            '#0077b5',
                            '#ff0000',
                            '#000000'
                        ]
                    }]
                },
                options: {
                    responsive: true,
                    maintainAspectRatio: false,
                    plugins: {
                        title: {
                            display: true,
                            text: 'Platform Follower Distribution'
                        }
                    }
                }
            });

            const ctx3 = document.getElementById('audience-chart').getContext('2d');
            audienceChart = new Chart(ctx3, {
                type: 'bar',
                data: {
                    labels: ['18-24', '25-34', '35-44', '45-54', '55+'],
                    datasets: [{
                        label: 'Age Distribution (%)',
                        data: [0, 0, 0, 0, 0],
                        backgroundColor: '#3498db'
                    }]
                },
                options: {
                    responsive: true,
                    maintainAspectRatio: false,
                    plugins: {
                        title: {
                            display: true,
                            text: 'Audience Demographics'
                        }
                    },
                    scales: {
                        y: { beginAtZero: true, max: 100 }
                    }
                }
            });
        }

        // Function to setup manual stats inputs
        function setupManualStatsInputs() {
            const statsGrid = document.getElementById('stats-grid');
            statsGrid.innerHTML = '';

            const platforms = [
                { id: 'fb', name: 'Facebook' },
                { id: 'ig', name: 'Instagram' },
                { id: 'tw', name: 'Twitter' },
                { id: 'li', name: 'LinkedIn' },
                { id: 'yt', name: 'YouTube' },
                { id: 'tt', name: 'TikTok' }
            ];

            const metrics = ['followers', 'views', 'likes', 'reposts'];

            platforms.forEach(platform => {
                metrics.forEach(metric => {
                    const formGroup = document.createElement('div');
                    formGroup.className = 'form-group';

                    const label = document.createElement('label');
                    label.htmlFor = `${platform.id}-${metric}`;
                    label.textContent = `${platform.name} ${metric.charAt(0).toUpperCase() + metric.slice(1)}`;

                    const input = document.createElement('input');
                    input.type = 'number';
                    input.id = `${platform.id}-${metric}`;
                    input.className = 'form-control';
                    input.placeholder = '0';

                    formGroup.appendChild(label);
                    formGroup.appendChild(input);
                    statsGrid.appendChild(formGroup);
                });
            });
        }

        // Function to setup platform metrics
        function setupPlatformMetrics() {
            const platformMetrics = document.getElementById('platform-metrics');
            platformMetrics.innerHTML = '';

            const platformsData = [
                { id: 'facebook', name: 'Facebook', icon: 'fa-facebook', color: '#3b5998' },
                { id: 'instagram', name: 'Instagram', icon: 'fa-instagram', color: '#e4405f' },
                { id: 'twitter', name: 'Twitter', icon: 'fa-twitter', color: '#1da1f2' },
                { id: 'linkedin', name: 'LinkedIn', icon: 'fa-linkedin', color: '#0077b5' },
                { id: 'youtube', name: 'YouTube', icon: 'fa-youtube', color: '#ff0000' },
                { id: 'tiktok', name: 'TikTok', icon: 'fa-tiktok', color: '#000000' }
            ];

            platformsData.forEach(platform => {
                const platformMetric = document.createElement('div');
                platformMetric.className = 'platform-metric';

                const heading = document.createElement('h4');
                heading.innerHTML = `<i class="fab ${platform.icon}" style="color: ${platform.color};"></i> ${platform.name}`;

                const metricGrid = document.createElement('div');
                metricGrid.className = 'metric-grid';

                const metrics = [
                    { value: '—', label: 'Followers', dataKey: 'followers' },
                    { value: '—', label: 'Engagement', dataKey: 'engagement' },
                    { value: '—', label: 'Views', dataKey: 'views' },
                    { value: '—', label: 'Likes', dataKey: 'likes' }
                ];

                metrics.forEach(metric => {
                    const metricItem = document.createElement('div');
                    metricItem.className = 'metric-item';

                    const value = document.createElement('span');
                    value.className = 'value';
                    value.dataset.key = metric.dataKey;
                    value.textContent = metric.value;

                    const label = document.createElement('span');
                    label.className = 'label';
                    label.textContent = metric.label;

                    metricItem.appendChild(value);
                    metricItem.appendChild(label);
                    metricGrid.appendChild(metricItem);
                });

                platformMetric.appendChild(heading);
                platformMetric.appendChild(metricGrid);
                platformMetrics.appendChild(platformMetric);
            });
        }

        // Function to check for daily notifications
        function checkDailyNotifications() {
            const today = new Date();
            const todayStr = today.toISOString().split('T')[0];

            const todaysContent = contentItems.filter(item => item.date === todayStr && item.status !== 'posted');

            if (todaysContent.length > 0) {
                document.getElementById('notification-count').textContent = todaysContent.length;
                const notificationList = document.getElementById('notification-list');
                notificationList.innerHTML = '';

                todaysContent.forEach(content => {
                    const notificationItem = document.createElement('div');
                    notificationItem.className = 'notification-item';
                    const icon = document.createElement('i');
                    icon.className = 'notification-icon fas fa-calendar-check';
                    const contentDiv = document.createElement('div');
                    contentDiv.className = 'notification-content';
                    const text = document.createElement('p');
                    text.textContent = `"${content.title}" is scheduled for today`;
                    const time = document.createElement('div');
                    time.className = 'notification-time';
                    time.textContent = 'Today';
                    contentDiv.appendChild(text);
                    contentDiv.appendChild(time);
                    notificationItem.appendChild(icon);
                    notificationItem.appendChild(contentDiv);
                    notificationList.appendChild(notificationItem);
                });
            }
        }

        // Function to render the calendar
        function renderCalendar(date) {
            const calendarGrid = document.getElementById('calendar-grid');
            calendarGrid.innerHTML = '';

            const monthNames = ["January", "February", "March", "April", "May", "June",
                "July", "August", "September", "October", "November", "December"];

            document.querySelector('.current-month').textContent =
                `${monthNames[date.getMonth()]} ${date.getFullYear()}`;

            const firstDay = new Date(date.getFullYear(), date.getMonth(), 1);
            const lastDay = new Date(date.getFullYear(), date.getMonth() + 1, 0);

            for (let i = 0; i < firstDay.getDay(); i++) {
                const emptyDay = document.createElement('div');
                emptyDay.classList.add('calendar-day', 'empty');
                calendarGrid.appendChild(emptyDay);
            }

            for (let i = 1; i <= lastDay.getDate(); i++) {
                const dayElement = document.createElement('div');
                dayElement.classList.add('calendar-day');
                const dayHeader = document.createElement('div');
                dayHeader.classList.add('day-header');
                const dayNumber = document.createElement('span');
                dayNumber.classList.add('day-number');
                dayNumber.textContent = i;
                const weekday = document.createElement('span');
                weekday.classList.add('weekday');
                const dayOfWeek = new Date(date.getFullYear(), date.getMonth(), i).getDay();
                const weekdays = ["Sun", "Mon", 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
                weekday.textContent = weekdays[dayOfWeek];
                dayHeader.appendChild(dayNumber);
                dayHeader.appendChild(weekday);
                const contentItemsContainer = document.createElement('div');
                contentItemsContainer.classList.add('content-items');
                const currentDateStr = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(i).padStart(2, '0')}`;
                let itemsForDay = contentItems.filter(item => item.date === currentDateStr);
                if (activeTopicFilter !== 'all') {
                    itemsForDay = itemsForDay.filter(item => item.topic === activeTopicFilter);
                }
                if (itemsForDay.length === 0) {
                    const noContent = document.createElement('p');
                    noContent.textContent = 'No content scheduled';
                    noContent.style.color = '#6c757d';
                    noContent.style.fontSize = '0.8rem';
                    contentItemsContainer.appendChild(noContent);
                } else {
                    itemsForDay.forEach(item => {
                        const contentElement = document.createElement('div');
                        contentElement.classList.add('content-item', item.status);
                        contentElement.dataset.id = item.id;
                        let icon = '';
                        if (item.type === 'video') icon = '<i class="fas fa-video"></i>';
                        else if (item.type === 'poster') icon = '<i class="fas fa-image"></i>';
                        else if (item.type === 'article') icon = '<i class="fas fa-file-alt"></i>';
                        let mediaThumbHtml = '';
                        if (item.media) {
                            const isVid = isVideoMedia(item.media, item.mediaType);
                            if (isVid) {
                                mediaThumbHtml = `<div class="content-item-preview-video" title="Video attached"><i class="fas fa-play"></i></div>`;
                            } else {
                                mediaThumbHtml = `<img src="${item.media}" class="content-item-preview-thumb" alt="media thumb" title="Image attached">`;
                            }
                        }
                        contentElement.innerHTML = `
                            ${mediaThumbHtml}
                            <div style="flex: 1; min-width: 0;">
                                <div style="font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; display: flex; align-items: center; gap: 4px;">${icon} <span>${item.title}</span></div>
                            </div>
                            ${item.media ? '<span class="content-media-badge" title="Media attached"><i class="fas fa-paperclip"></i></span>' : ''}
                        `;
                        contentItemsContainer.appendChild(contentElement);
                        contentElement.addEventListener('click', () => {
                            showContentDetails(item.id);
                        });
                    });
                }
                dayElement.appendChild(dayHeader);
                dayElement.appendChild(contentItemsContainer);
                calendarGrid.appendChild(dayElement);
            }
        }

        // Function to render topics in sidebar
        function renderTopics() {
            const topicsList = document.getElementById('topics-list');
            topicsList.innerHTML = '<div class="topic-item active" data-topic="all"><i class="fas fa-th-large"></i><span>All Topics</span></div>';
            topics.forEach(topic => {
                const topicElement = document.createElement('div');
                topicElement.classList.add('topic-item');
                topicElement.dataset.topic = topic.id;
                topicElement.innerHTML = `<i class="fas ${topic.icon}"></i><span>${topic.name}</span>`;
                topicsList.appendChild(topicElement);
            });
            document.querySelectorAll('.topic-item').forEach(item => {
                item.addEventListener('click', function () {
                    document.querySelectorAll('.topic-item').forEach(i => i.classList.remove('active'));
                    this.classList.add('active');
                    activeTopicFilter = this.dataset.topic;
                    renderCalendar(currentDate);
                });
            });
        }

        // Function to populate topic dropdown in content form
        function populateTopicDropdown() {
            const topicDropdown = document.getElementById('content-topic');
            topicDropdown.innerHTML = '';
            topics.forEach(topic => {
                const option = document.createElement('option');
                option.value = topic.id;
                option.textContent = topic.name;
                topicDropdown.appendChild(option);
            });
        }

        // Function to show content details
        function showContentDetails(contentId) {
            const content = contentItems.find(item => item.id === contentId);
            if (!content) return;
            currentContentId = contentId;
            document.getElementById('detail-title').textContent = content.title;
            document.getElementById('detail-topic').textContent =
                topics.find(t => t.id === content.topic)?.name || content.topic;
            document.getElementById('detail-type').textContent =
                content.type.charAt(0).toUpperCase() + content.type.slice(1);
            document.getElementById('detail-description').textContent = content.description || 'No description';
            document.getElementById('detail-date').textContent = content.date;
            document.getElementById('detail-platforms').textContent = content.platforms.join(', ');
            document.getElementById('detail-status').textContent =
                content.status.charAt(0).toUpperCase() + content.status.slice(1);
            const mediaContainer = document.getElementById('detail-media-container');
            const imgEl = document.getElementById('detail-media-img');
            const videoEl = document.getElementById('detail-media-video');
            if (content.media) {
                const isVid = isVideoMedia(content.media, content.mediaType);
                if (isVid) {
                    if (imgEl) { imgEl.style.display = 'none'; imgEl.src = ''; }
                    if (videoEl) { videoEl.src = content.media; videoEl.style.display = 'inline-block'; }
                } else {
                    if (videoEl) { videoEl.style.display = 'none'; videoEl.src = ''; }
                    if (imgEl) { imgEl.src = content.media; imgEl.style.display = 'inline-block'; }
                }
                if (mediaContainer) mediaContainer.style.display = 'block';
            } else {
                if (mediaContainer) mediaContainer.style.display = 'none';
                if (imgEl) { imgEl.style.display = 'none'; imgEl.src = ''; }
                if (videoEl) { videoEl.style.display = 'none'; videoEl.src = ''; }
            }
            document.getElementById('post-link-form').style.display = 'none';
            document.getElementById('detail-modal').style.display = 'flex';
        }

        // Function to show toast notification
        function showToast(message, isError = false) {
            const toast = document.getElementById('toast');
            const toastIcon = document.getElementById('toast-icon');
            const toastMessage = document.getElementById('toast-message');
            toastMessage.textContent = message;
            if (isError) {
                toast.classList.add('error');
                toastIcon.className = 'fas fa-exclamation-circle';
            } else {
                toast.classList.remove('error');
                toastIcon.className = 'fas fa-check-circle';
            }
            toast.classList.add('show');
            setTimeout(() => {
                toast.classList.remove('show');
            }, 3000);
        }

        // Function to reset the content form
        function resetContentForm() {
            document.getElementById('content-form').reset();
            document.getElementById('content-id').value = '';
            document.getElementById('content-modal-title').textContent = 'Add New Content';
            displayMediaPreview(null);
            const progressBar = document.getElementById('upload-progress');
            const progressBarInner = document.getElementById('upload-progress-bar');
            if (progressBar) progressBar.style.display = 'none';
            if (progressBarInner) progressBarInner.style.width = '0%';
            document.querySelectorAll('.status-btn').forEach(btn => btn.classList.remove('active'));
            document.querySelector('.status-btn[data-status="planned"]').classList.add('active');
            document.getElementById('content-status').value = 'planned';
            currentMedia = null;
            currentMediaType = null;
            currentMediaFile = null;
        }

        // Function to populate the content form for editing
        function populateContentForm(content) {
            document.getElementById('content-id').value = content.id;
            document.getElementById('content-title').value = content.title;
            document.getElementById('content-description').value = content.description || '';
            document.getElementById('content-topic').value = content.topic;
            document.getElementById('content-type').value = content.type;
            document.getElementById('content-date').value = content.date;
            document.getElementById('content-status').value = content.status;
            document.querySelectorAll('.platform-checkbox input').forEach(checkbox => {
                checkbox.checked = content.platforms.includes(checkbox.value);
            });
            document.querySelectorAll('.status-btn').forEach(btn => {
                btn.classList.remove('active');
                if (btn.dataset.status === content.status) {
                    btn.classList.add('active');
                }
            });
            if (content.media) {
                currentMedia = content.media;
                currentMediaType = content.mediaType || (isVideoMedia(content.media) ? 'video' : 'image');
                displayMediaPreview(currentMedia, currentMediaType);
            } else {
                currentMedia = null;
                currentMediaType = null;
                displayMediaPreview(null);
            }
            document.getElementById('content-modal-title').textContent = 'Edit Content';
        }

        // Function to copy text content for social media
        function copyTextContent(content, platform) {
            let formattedContent = '';
            formattedContent = `${content.title}\n\n`;
            if (content.description) {
                formattedContent += `${content.description}\n\n`;
            }
            switch (platform) {
                case 'facebook':
                    formattedContent += `#Tech #${content.topic.charAt(0).toUpperCase() + content.topic.slice(1)} #Facebook`;
                    break;
                case 'instagram':
                    formattedContent += `#Tech #${content.topic.charAt(0).toUpperCase() + content.topic.slice(1)} #Instagram`;
                    break;
                case 'twitter':
                    formattedContent += `#Tech #${content.topic.charAt(0).toUpperCase() + content.topic.slice(1)} #Twitter`;
                    break;
                case 'linkedin':
                    formattedContent += `#Tech #${content.topic.charAt(0).toUpperCase() + content.topic.slice(1)} #LinkedIn #Professional`;
                    break;
                case 'youtube':
                    formattedContent += `#Tech #${content.topic.charAt(0).toUpperCase() + content.topic.slice(1)} #YouTube`;
                    break;
                case 'tiktok':
                    formattedContent += `#Tech #${content.topic.charAt(0).toUpperCase() + content.topic.slice(1)} #TikTok`;
                    break;
                default:
                    formattedContent += `#Tech #${content.topic.charAt(0).toUpperCase() + content.topic.slice(1)}`;
            }
            navigator.clipboard.writeText(formattedContent).then(() => {
                showToast(`Text content copied for ${platform.charAt(0).toUpperCase() + platform.slice(1)}!`);
            }).catch(err => {
                showToast('Failed to copy content', true);
                console.error('Copy error:', err);
            });
        }

        // Function to download media
        function downloadMedia(content) {
            if (!content || !content.media) {
                showToast('No media to download', true);
                return;
            }
            const isVid = isVideoMedia(content.media, content.mediaType);
            const ext = isVid ? 'mp4' : 'png';
            const a = document.createElement('a');
            a.href = content.media;
            const safeTitle = (content.title || 'media').toLowerCase().replace(/[^a-z0-9]+/g, '-');
            a.download = `kiwami-content-${safeTitle}.${ext}`;
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
            showToast('Media downloaded successfully!');
        }

        // Function to download content
        function downloadContent(content) {
            const textContent = `
KIWAMI MARKETING SYSTEM CONTENT
================================

Title: ${content.title}
Description: ${content.description || 'No description'}
Topic: ${topics.find(t => t.id === content.topic)?.name || content.topic}
Type: ${content.type.charAt(0).toUpperCase() + content.type.slice(1)}
Scheduled Date: ${content.date}
Platforms: ${content.platforms.join(', ')}
Status: ${content.status.charAt(0).toUpperCase() + content.status.slice(1)}

${content.media ? 'Media attached: Yes' : 'Media attached: No'}
                    `.trim();
            const blob = new Blob([textContent], { type: 'text/plain' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = `kiwami-content-${content.title.toLowerCase().replace(/\s+/g, '-')}.txt`;
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
            URL.revokeObjectURL(url);
            showToast('Content downloaded successfully!');
        }

        // Function to open social media platform
        function openSocialMediaPlatform(platform, content) {
            let url = '';
            switch (platform) {
                case 'facebook':
                    url = 'https://www.facebook.com/';
                    break;
                case 'instagram':
                    url = 'https://www.instagram.com/';
                    break;
                case 'twitter':
                    url = 'https://twitter.com/';
                    break;
                case 'linkedin':
                    url = 'https://www.linkedin.com/';
                    break;
                case 'youtube':
                    url = 'https://www.youtube.com/';
                    break;
                case 'tiktok':
                    url = 'https://www.tiktok.com/';
                    break;
            }
            copyTextContent(content, platform);
            window.open(url, '_blank');
            document.getElementById('post-link-form').style.display = 'block';
            selectedPlatform = platform;
        }

        const PLATFORMS = ['youtube', 'twitter', 'facebook', 'instagram', 'linkedin', 'tiktok'];

        function saveApiKeys() {
            const saved = {};
            PLATFORMS.forEach(p => {
                const val = (document.getElementById(`key-${p}`) || {}).value || '';
                if (val.trim()) saved[p] = val.trim();
            });
            localStorage.setItem('kiwami_api_keys', JSON.stringify(saved));
            PLATFORMS.forEach(p => markKeyDot(p, saved[p] || ''));
            showToast('API keys saved to browser storage!');
        }

        function loadApiKeys() {
            let saved = {};
            try { saved = JSON.parse(localStorage.getItem('kiwami_api_keys') || '{}'); } catch { }
            PLATFORMS.forEach(p => {
                const inp = document.getElementById(`key-${p}`);
                if (inp && saved[p]) inp.value = saved[p];
                markKeyDot(p, saved[p] || '');
            });
            return saved;
        }

        function getApiKeys() {
            let saved = {};
            try { saved = JSON.parse(localStorage.getItem('kiwami_api_keys') || '{}'); } catch { }
            return saved;
        }

        function clearApiKeys() {
            localStorage.removeItem('kiwami_api_keys');
            PLATFORMS.forEach(p => {
                const inp = document.getElementById(`key-${p}`);
                if (inp) inp.value = '';
                markKeyDot(p, '');
            });
            showToast('All API keys cleared.');
        }

        function markKeyDot(platform, value) {
            const dot = document.getElementById(`dot-${platform}`);
            if (dot) dot.className = 'key-status-dot' + (value && value.trim() ? ' set' : '');
        }

        function toggleApiKeysPanel() {
            const body = document.getElementById('api-keys-body');
            const icon = document.getElementById('api-toggle-icon');
            const open = body.style.display !== 'none' && body.style.display !== '';
            body.style.display = open ? 'none' : 'block';
            if (icon) icon.className = 'fas fa-chevron-down api-toggle-icon' + (open ? '' : ' open');
        }

        loadApiKeys();

        const PLATFORM_META = {
            youtube: { label: 'YouTube', icon: 'fab fa-youtube', color: '#ff0000' },
            twitter: { label: 'Twitter/X', icon: 'fab fa-twitter', color: '#1da1f2' },
            facebook: { label: 'Facebook', icon: 'fab fa-facebook', color: '#3b5998' },
            instagram: { label: 'Instagram', icon: 'fab fa-instagram', color: '#e4405f' },
            linkedin: { label: 'LinkedIn', icon: 'fab fa-linkedin', color: '#0077b5' },
            tiktok: { label: 'TikTok', icon: 'fab fa-tiktok', color: '#000000' }
        };

        function renderPlatformStatus(platforms) {
            const grid = document.getElementById('platform-status-grid');
            const panel = document.getElementById('connection-status-panel');
            if (!grid) return;
            grid.innerHTML = '';
            panel.style.display = 'block';
            for (const [pid, data] of Object.entries(platforms)) {
                const meta = PLATFORM_META[pid] || { label: pid, icon: 'fas fa-globe', color: '#888' };
                const card = document.createElement('div');
                card.className = 'ps-card';
                let tagText = '', tagClass = '', detailText = '', metricsHtml = '';
                if (data.status === 'ok') {
                    card.classList.add('status-ok');
                    tagText = '✓ CONNECTED'; tagClass = 'ok';
                    detailText = data.name ? `@${data.name}` : '';
                    metricsHtml = `<div class="ps-metric">👥 ${formatNumber((data.followers || 0).toString())} followers &nbsp;|&nbsp; 🎬 ${formatNumber((data.posts || 0).toString())} posts</div>`;
                } else if (data.status === 'no_url') {
                    card.classList.add('status-no-url');
                    tagText = 'SKIPPED'; tagClass = 'skipped';
                    detailText = 'No URL entered';
                } else if (data.status === 'no_credentials') {
                    card.classList.add('status-unconfigured');
                    tagText = 'NO API KEY'; tagClass = 'warn';
                    detailText = data.setup || data.error || 'Configure API key in Step 1 above';
                } else {
                    card.classList.add('status-error');
                    tagText = 'ERROR'; tagClass = 'error';
                    detailText = data.error || 'Unknown error';
                    if (data.setup) detailText += ` — ${data.setup}`;
                }
                card.innerHTML = `
                    <i class="${meta.icon} ps-icon" style="color:${meta.color}"></i>
                    <div class="ps-info">
                        <div class="ps-name">${meta.label} <span class="ps-tag ${tagClass}">${tagText}</span></div>
                        <div class="ps-detail">${detailText}</div>
                        ${metricsHtml}
                    </div>`;
                grid.appendChild(card);
            }
        }

        function applyAnalyticsData(data) {
            const platformOrder = PLATFORMS;
            document.getElementById('total-posts').textContent = data.totalPosts !== undefined ? data.totalPosts : '—';
            document.getElementById('engagement-rate').textContent = data.engagementRate !== undefined ? data.engagementRate + '%' : '—';
            document.getElementById('total-followers').textContent = data.totalFollowers !== undefined ? formatNumber(data.totalFollowers.toString()) : '—';
            document.getElementById('total-views').textContent = data.totalViews !== undefined ? formatNumber(data.totalViews.toString()) : '—';
            document.getElementById('total-posts-change').textContent = data.fetchedAt ? `Fetched at ${new Date(data.fetchedAt).toLocaleTimeString()}` : '';
            document.getElementById('engagement-rate-change').textContent = 'Avg across connected platforms';
            document.getElementById('total-followers-change').textContent = 'Combined all platforms';
            document.getElementById('total-views-change').textContent = 'Combined all platforms';
            const platformCards = document.querySelectorAll('.platform-metric');
            platformOrder.forEach((pid, idx) => {
                const pData = data.platforms?.[pid];
                if (!pData || pData.status !== 'ok' || !platformCards[idx]) return;
                const values = platformCards[idx].querySelectorAll('.value');
                if (values[0]) values[0].textContent = formatNumber((pData.followers || 0).toString());
                if (values[1]) values[1].textContent = (pData.engagement ?? '—') + (pData.engagement !== undefined ? '%' : '');
                if (values[2]) values[2].textContent = formatNumber((pData.views || 0).toString());
                if (values[3]) values[3].textContent = formatNumber((pData.likes || 0).toString());
            });
            platformChart.data.datasets[0].data = platformOrder.map(pid => {
                const p = data.platforms?.[pid];
                return (p && p.status === 'ok') ? (p.followers || 0) : 0;
            });
            platformChart.update();
        }

        async function fetchSocialMediaAnalytics() {
            const profileUrls = {
                facebook: document.getElementById('facebook-profile').value.trim(),
                instagram: document.getElementById('instagram-profile').value.trim(),
                twitter: document.getElementById('twitter-profile').value.trim(),
                linkedin: document.getElementById('linkedin-profile').value.trim(),
                youtube: document.getElementById('youtube-profile').value.trim(),
                tiktok: document.getElementById('tiktok-profile').value.trim()
            };
            const hasAnyProfile = Object.values(profileUrls).some(v => v !== '');
            if (!hasAnyProfile) {
                showToast('Please enter at least one social media profile URL in Step 2', true);
                return;
            }
            const apiKeys = getApiKeys();
            const fetchBtn = document.getElementById('fetch-analytics');
            const fetchIcon = document.getElementById('fetch-icon');
            fetchBtn.disabled = true;
            if (fetchIcon) fetchIcon.className = 'fas fa-spinner fa-spin';
            showToast('Contacting social media APIs…');
            try {
                const response = await fetch('/api/analytics', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ profiles: profileUrls, apiKeys })
                });
                const data = await response.json();
                if (!response.ok) {
                    throw new Error(data.error || `Server error ${response.status}`);
                }
                renderPlatformStatus(data.platforms || {});
                const successCount = Object.values(data.platforms || {}).filter(p => p.status === 'ok').length;
                if (successCount > 0) {
                    applyAnalyticsData(data);
                    showToast(`✅ Real data fetched from ${successCount} platform(s)!`);
                } else {
                    showToast('No platforms returned data. Check your API keys in Step 1.', true);
                    const body = document.getElementById('api-keys-body');
                    if (body && body.style.display === 'none') toggleApiKeysPanel();
                }
            } catch (err) {
                console.error('Analytics fetch error:', err);
                showToast(err.message.includes('server') ? err.message : 'Could not reach the server. Make sure server.js is running on port 3000.', true);
            } finally {
                fetchBtn.disabled = false;
                if (fetchIcon) fetchIcon.className = 'fas fa-sync';
            }
        }

        function updateManualStats() {
            const platformDefs = [
                { prefix: 'fb', label: 'Facebook', engRate: null },
                { prefix: 'ig', label: 'Instagram', engRate: null },
                { prefix: 'tw', label: 'Twitter', engRate: null },
                { prefix: 'li', label: 'LinkedIn', engRate: null },
                { prefix: 'yt', label: 'YouTube', engRate: null },
                { prefix: 'tt', label: 'TikTok', engRate: null }
            ];
            let hasAnyValue = false;
            let totalFollowers = 0;
            let totalViews = 0;
            let totalLikes = 0;
            const platformCards = document.querySelectorAll('.platform-metric');
            const followerDistrib = [];
            platformDefs.forEach((pDef, idx) => {
                const followersRaw = document.getElementById(`${pDef.prefix}-followers`).value.trim();
                const viewsRaw = document.getElementById(`${pDef.prefix}-views`).value.trim();
                const likesRaw = document.getElementById(`${pDef.prefix}-likes`).value.trim();
                const followersNum = followersRaw !== '' ? parseInt(followersRaw) : null;
                const viewsNum = viewsRaw !== '' ? parseInt(viewsRaw) : null;
                const likesNum = likesRaw !== '' ? parseInt(likesRaw) : null;
                let engRate = '—';
                if (followersNum && likesNum && followersNum > 0) {
                    engRate = ((likesNum / followersNum) * 100).toFixed(1) + '%';
                }
                if (followersNum !== null) { totalFollowers += followersNum; hasAnyValue = true; }
                if (viewsNum !== null) { totalViews += viewsNum; hasAnyValue = true; }
                if (likesNum !== null) { totalLikes += likesNum; hasAnyValue = true; }
                followerDistrib.push(followersNum || 0);
                if (platformCards[idx]) {
                    const vals = platformCards[idx].querySelectorAll('.value');
                    if (vals[0]) vals[0].textContent = followersNum !== null ? formatNumber(followersRaw) : '—';
                    if (vals[1]) vals[1].textContent = engRate;
                    if (vals[2]) vals[2].textContent = viewsNum !== null ? formatNumber(viewsRaw) : '—';
                    if (vals[3]) vals[3].textContent = likesNum !== null ? formatNumber(likesRaw) : '—';
                }
            });
            if (!hasAnyValue) {
                showToast('Please enter at least one value to update statistics', true);
                return;
            }
            const overallEng = totalFollowers > 0 ? ((totalLikes / totalFollowers) * 100).toFixed(1) + '%' : '—';
            document.getElementById('total-followers').textContent = formatNumber(totalFollowers.toString());
            document.getElementById('total-views').textContent = formatNumber(totalViews.toString());
            document.getElementById('engagement-rate').textContent = overallEng;
            document.getElementById('total-followers-change').textContent = 'Manually updated';
            document.getElementById('total-views-change').textContent = 'Manually updated';
            document.getElementById('engagement-rate-change').textContent = 'Manually updated';
            platformChart.data.datasets[0].data = followerDistrib;
            platformChart.update();
            showToast('Statistics updated successfully!');
        }

        function formatNumber(value) {
            if (!value || value.toString().trim() === '') return '—';
            const str = value.toString().trim();
            if (str.toUpperCase().includes('K') || str.toUpperCase().includes('M')) return str;
            const num = parseInt(str, 10);
            if (isNaN(num)) return str;
            if (num >= 1000000) return (num / 1000000).toFixed(1) + 'M';
            if (num >= 1000) return (num / 1000).toFixed(1) + 'K';
            return num.toString();
        }

        function switchAppTab(tabName) {
            document.querySelectorAll('.nav-tab').forEach(t => {
                t.classList.toggle('active', t.dataset.tab === tabName);
            });
            document.querySelectorAll('.tab-content').forEach(content => {
                content.classList.remove('active');
            });
            const targetTabContent = document.getElementById(`${tabName}-tab`);
            if (targetTabContent) {
                targetTabContent.classList.add('active');
            }
            if (tabName === 'calendar') {
                document.getElementById('calendar-view').style.display = 'block';
                document.getElementById('analytics-view').style.display = 'none';
            } else if (tabName === 'analytics') {
                document.getElementById('calendar-view').style.display = 'none';
                document.getElementById('analytics-view').style.display = 'block';
            }
        }
        window.switchAppTab = switchAppTab;

        function setupEventListeners() {
            document.getElementById('prev-month').addEventListener('click', function () {
                currentDate.setMonth(currentDate.getMonth() - 1);
                renderCalendar(currentDate);
            });
            document.getElementById('next-month').addEventListener('click', function () {
                currentDate.setMonth(currentDate.getMonth() + 1);
                renderCalendar(currentDate);
            });
            document.getElementById('notification-bell').addEventListener('click', function () {
                const notificationModal = document.getElementById('notification-modal');
                if (notificationModal.style.display === 'block') {
                    notificationModal.style.display = 'none';
                } else {
                    notificationModal.style.display = 'block';
                }
            });
            document.getElementById('close-notifications').addEventListener('click', function () {
                document.getElementById('notification-modal').style.display = 'none';
            });
            document.querySelectorAll('.nav-tab').forEach(tab => {
                tab.addEventListener('click', function () {
                    switchAppTab(this.dataset.tab);
                });
            });
            document.getElementById('sidebar-toggle').addEventListener('click', function () {
                document.getElementById('sidebar').classList.toggle('open');
            });
            document.getElementById('fetch-analytics').addEventListener('click', fetchSocialMediaAnalytics);
            document.getElementById('update-stats').addEventListener('click', updateManualStats);
            const modals = document.querySelectorAll('.modal');
            const closeButtons = document.querySelectorAll('.close');
            document.getElementById('add-content-btn').addEventListener('click', function () {
                resetContentForm();
                const today = new Date();
                const formattedDate = today.toISOString().split('T')[0];
                document.getElementById('content-date').value = formattedDate;
                document.getElementById('content-modal').style.display = 'flex';
            });
            document.getElementById('add-topic-btn').addEventListener('click', function () {
                document.getElementById('topic-modal').style.display = 'flex';
            });
            closeButtons.forEach(button => {
                button.addEventListener('click', function () {
                    modals.forEach(modal => {
                        modal.style.display = 'none';
                    });
                });
            });
            modals.forEach(modal => {
                modal.addEventListener('click', function (e) {
                    if (e.target === modal) {
                        modal.style.display = 'none';
                    }
                });
            });
            document.addEventListener('click', function (e) {
                const notificationModal = document.getElementById('notification-modal');
                const notificationBell = document.getElementById('notification-bell');
                if (notificationModal.style.display === 'block' &&
                    !notificationModal.contains(e.target) &&
                    !notificationBell.contains(e.target)) {
                    notificationModal.style.display = 'none';
                }
            });
            const statusButtons = document.querySelectorAll('.status-btn');
            statusButtons.forEach(button => {
                button.addEventListener('click', function () {
                    statusButtons.forEach(btn => btn.classList.remove('active'));
                    this.classList.add('active');
                    document.getElementById('content-status').value = this.dataset.status;
                });
            });
            const uploadArea = document.getElementById('media-upload-area');
            const fileInput = document.getElementById('media-file');
            if (uploadArea && fileInput) {
                uploadArea.addEventListener('click', function () {
                    fileInput.click();
                });
                ['dragenter', 'dragover'].forEach(eventName => {
                    uploadArea.addEventListener(eventName, (e) => {
                        e.preventDefault();
                        e.stopPropagation();
                        uploadArea.classList.add('dragover');
                    });
                });
                ['dragleave', 'drop'].forEach(eventName => {
                    uploadArea.addEventListener(eventName, (e) => {
                        e.preventDefault();
                        e.stopPropagation();
                        uploadArea.classList.remove('dragover');
                    });
                });
                uploadArea.addEventListener('drop', (e) => {
                    const files = e.dataTransfer?.files;
                    if (files && files.length > 0) {
                        processMediaFile(files[0]);
                    }
                });
                fileInput.addEventListener('change', function (e) {
                    const file = e.target.files[0];
                    if (file) {
                        processMediaFile(file);
                    }
                });
            }
            const removeBtn = document.getElementById('remove-media');
            if (removeBtn) {
                removeBtn.addEventListener('click', function (e) {
                    e.stopPropagation();
                    currentMedia = null;
                    currentMediaType = null;
                    currentMediaFile = null;
                    if (fileInput) fileInput.value = '';
                    displayMediaPreview(null);
                    showToast('Media removed');
                });
            }
            document.getElementById('content-form').addEventListener('submit', async function (e) {
                e.preventDefault();
                const id = document.getElementById('content-id').value || Date.now();
                const title = document.getElementById('content-title').value;
                const description = document.getElementById('content-description').value;
                const topic = document.getElementById('content-topic').value;
                const type = document.getElementById('content-type').value;
                const date = document.getElementById('content-date').value;
                const status = document.getElementById('content-status').value;
                const platforms = [];
                document.querySelectorAll('.platform-checkbox input:checked').forEach(checkbox => {
                    platforms.push(checkbox.value);
                });
                if (platforms.length === 0) {
                    showToast('Please select at least one platform', true);
                    return;
                }
                const contentData = {
                    id: parseInt(id),
                    title,
                    description,
                    topic,
                    type,
                    date,
                    platforms,
                    status
                };
                if (currentMedia) {
                    contentData.media = currentMedia;
                    contentData.mediaType = currentMediaType || (isVideoMedia(currentMedia) ? 'video' : 'image');
                }
                const existingIndex = contentItems.findIndex(item => item.id === contentData.id);
                if (existingIndex !== -1) {
                    contentItems[existingIndex] = contentData;
                    showToast('Content updated successfully!');
                } else {
                    contentItems.push(contentData);
                    showToast('Content added successfully!');
                }
                localStorage.setItem('contentItems', JSON.stringify(contentItems));
                renderCalendar(currentDate);
                checkDailyNotifications();
                document.getElementById('content-modal').style.display = 'none';
                resetContentForm();
            });
            document.getElementById('copy-content').addEventListener('click', function () {
                const title = document.getElementById('content-title').value;
                const description = document.getElementById('content-description').value;
                const topic = document.getElementById('content-topic').value;
                if (!title) {
                    showToast('Please add a title first', true);
                    return;
                }
                const contentData = {
                    title,
                    description,
                    topic: topics.find(t => t.id === topic)?.name || topic
                };
                copyTextContent(contentData, 'general');
            });
            document.getElementById('download-media').addEventListener('click', function () {
                const title = document.getElementById('content-title').value;
                if (!currentMedia) {
                    showToast('No media to download', true);
                    return;
                }
                const contentData = {
                    title,
                    media: currentMedia
                };
                downloadMedia(contentData);
            });
            document.getElementById('download-content').addEventListener('click', function () {
                const title = document.getElementById('content-title').value;
                const description = document.getElementById('content-description').value;
                const topic = document.getElementById('content-topic').value;
                const type = document.getElementById('content-type').value;
                const date = document.getElementById('content-date').value;
                const status = document.getElementById('content-status').value;
                const platforms = [];
                document.querySelectorAll('.platform-checkbox input:checked').forEach(checkbox => {
                    platforms.push(checkbox.value);
                });
                if (!title) {
                    showToast('Please add a title first', true);
                    return;
                }
                const contentData = {
                    id: Date.now(),
                    title,
                    description,
                    topic,
                    type,
                    date,
                    platforms,
                    status,
                    media: currentMedia
                };
                downloadContent(contentData);
            });
            document.getElementById('topic-form').addEventListener('submit', function (e) {
                e.preventDefault();
                const name = document.getElementById('topic-name').value;
                const icon = document.getElementById('topic-icon').value;
                const id = name.toLowerCase().replace(/[^a-z0-9]+/g, '-');
                if (topics.some(topic => topic.id === id)) {
                    showToast('Topic already exists!', true);
                    return;
                }
                topics.push({ id, name, icon });
                localStorage.setItem('topics', JSON.stringify(topics));
                renderTopics();
                populateTopicDropdown();
                showToast('Topic added successfully!');
                document.getElementById('topic-modal').style.display = 'none';
                this.reset();
            });
            document.getElementById('post-facebook').addEventListener('click', function () {
                const content = contentItems.find(item => item.id === currentContentId);
                if (content) {
                    openSocialMediaPlatform('facebook', content);
                }
            });
            document.getElementById('post-instagram').addEventListener('click', function () {
                const content = contentItems.find(item => item.id === currentContentId);
                if (content) {
                    openSocialMediaPlatform('instagram', content);
                }
            });
            document.getElementById('post-twitter').addEventListener('click', function () {
                const content = contentItems.find(item => item.id === currentContentId);
                if (content) {
                    openSocialMediaPlatform('twitter', content);
                }
            });
            document.getElementById('post-linkedin').addEventListener('click', function () {
                const content = contentItems.find(item => item.id === currentContentId);
                if (content) {
                    openSocialMediaPlatform('linkedin', content);
                }
            });
            document.getElementById('post-youtube').addEventListener('click', function () {
                const content = contentItems.find(item => item.id === currentContentId);
                if (content) {
                    openSocialMediaPlatform('youtube', content);
                }
            });
            document.getElementById('post-tiktok').addEventListener('click', function () {
                const content = contentItems.find(item => item.id === currentContentId);
                if (content) {
                    openSocialMediaPlatform('tiktok', content);
                }
            });
            document.getElementById('copy-content-detail').addEventListener('click', function () {
                if (currentContentId) {
                    const content = contentItems.find(item => item.id === currentContentId);
                    if (content) {
                        copyTextContent(content, 'general');
                    }
                }
            });
            document.getElementById('download-media-detail').addEventListener('click', function () {
                if (currentContentId) {
                    const content = contentItems.find(item => item.id === currentContentId);
                    if (content) {
                        downloadMedia(content);
                    }
                }
            });
            document.getElementById('confirm-post').addEventListener('click', function () {
                const postLink = document.getElementById('post-link').value;
                if (!postLink) {
                    showToast('Please enter a valid URL', true);
                    return;
                }
                if (currentContentId) {
                    const contentIndex = contentItems.findIndex(item => item.id === currentContentId);
                    if (contentIndex !== -1) {
                        contentItems[contentIndex].status = 'posted';
                        if (!contentItems[contentIndex].postLinks) {
                            contentItems[contentIndex].postLinks = {};
                        }
                        contentItems[contentIndex].postLinks[selectedPlatform] = postLink;
                        localStorage.setItem('contentItems', JSON.stringify(contentItems));
                        renderCalendar(currentDate);
                        showToast('Content status updated to Posted!');
                        document.getElementById('detail-modal').style.display = 'none';
                    }
                }
            });
            document.getElementById('edit-content-btn').addEventListener('click', function () {
                if (currentContentId) {
                    const content = contentItems.find(item => item.id === currentContentId);
                    if (content) {
                        document.getElementById('detail-modal').style.display = 'none';
                        populateContentForm(content);
                        document.getElementById('content-modal').style.display = 'flex';
                    }
                }
            });
            document.getElementById('download-content-detail').addEventListener('click', function () {
                if (currentContentId) {
                    const content = contentItems.find(item => item.id === currentContentId);
                    if (content) {
                        downloadContent(content);
                    }
                }
            });
            document.getElementById('delete-content-btn').addEventListener('click', function () {
                if (currentContentId) {
                    if (confirm('Are you sure you want to delete this content?')) {
                        contentItems = contentItems.filter(item => item.id !== currentContentId);
                        localStorage.setItem('contentItems', JSON.stringify(contentItems));
                        renderCalendar(currentDate);
                        showToast('Content deleted successfully!');
                        document.getElementById('detail-modal').style.display = 'none';
                    }
                }
            });
            const logoutBtn = document.getElementById('logout-btn');
            if (logoutBtn) {
                logoutBtn.addEventListener('click', async function () {
                    if (confirm('Are you sure you want to logout?')) {
                        try {
                            await fetch('/api/logout', { method: 'POST', cache: 'no-store' });
                        } catch {
                        }
                        sessionStorage.removeItem('isLoggedIn');
                        window.location.reload();
                    }
                });
            }
        }
    }
});
