<?php
declare(strict_types=1);

namespace OCA\TalkRh\Controller;

use OCA\TalkRh\AppInfo\Application;
use OCA\TalkRh\Service\LeaveService;
use OCP\AppFramework\Controller;
use OCP\AppFramework\Http\JSONResponse;
use OCP\IConfig;
use OCP\IGroupManager;
use OCP\IRequest;
use OCP\IUserSession;
use OCP\IUserManager;
use OCP\Accounts\IAccountManager;
use Psr\Log\LoggerInterface;

class ApiController extends Controller {
    public function __construct(
        string $appName,
        IRequest $request,
        private LeaveService $leaveService,
        private IUserSession $userSession,
        private IGroupManager $groupManager,
        private IConfig $config,
        private IUserManager $userManager,
        private IAccountManager $accountManager,
        private LoggerInterface $logger,
    ) {
        parent::__construct($appName, $request);
    }

    private function ensureLoggedIn(): void {
        if ($this->userSession->getUser() === null) {
            throw new \Exception('Not logged in');
        }
    }

    private function ensureAppAdmin(): void {
        $user = $this->userSession->getUser();
        if ($user === null) {
            throw new \Exception('Not logged in');
        }
        $adminGroup = Application::getAdminGroupId($this->config);
        $isServerAdmin = $this->groupManager->isAdmin($user->getUID());
        $isAppAdmin = $this->groupManager->isInGroup($user->getUID(), $adminGroup);
        if (!$isServerAdmin && !$isAppAdmin) {
            throw new \Exception('Admin privileges required');
        }
    }

    /**
     * @NoAdminRequired
     * @NoCSRFRequired
     */
    public function getMyLeaves(): JSONResponse {
        $this->ensureLoggedIn();
        $user = $this->userSession->getUser();
        $data = $this->leaveService->getLeavesForUser($user->getUID());
        return new JSONResponse(['leaves' => $data]);
    }
    /**
     * @NoAdminRequired
     * @NoCSRFRequired
     */
    public function listMyEmployees(): JSONResponse {
        // Mirror calendar permissions: only app admins/managers; build from existing leaves
        $this->ensureAppAdmin();
        $user = $this->userSession->getUser();
        $superUid = $user->getUID();
        $employees = [];
        try {
            // Enumerate users and filter by supervisor relation
            $candidates = method_exists($this->userManager, 'search') ? $this->userManager->search('', 2000, 0) : [];
            foreach ($candidates as $u) {
                $uid = $u->getUID();
                if ($uid === $superUid) continue;
                if ($this->isSupervisorOf($superUid, $uid)) {
                    $employees[] = [
                        'uid' => $uid,
                        'displayName' => $u->getDisplayName(),
                    ];
                }
            }
            // Deduplicate just in case
            $employees = array_values(array_unique($employees, SORT_REGULAR));
        } catch (\Throwable $e) {
            // ignore and return best-effort
        }
        return new JSONResponse(['employees' => $employees]);
    }
    
    /**
     * @NoAdminRequired
     * @NoCSRFRequired
     */
    public function createLeave(string $startDate, string $endDate, string $type = 'paid', string $reason = '', string $dayParts = '', string $targetUid = ''): JSONResponse {
        $this->ensureLoggedIn();
        $user = $this->userSession->getUser();
        $creatorUid = $user->getUID();
        $target = trim($targetUid) !== '' ? trim($targetUid) : $creatorUid;
        if ($target !== $creatorUid) {
            // Allow only if current user is supervisor of target (or server/app admin)
            $isServerAdmin = $this->groupManager->isAdmin($creatorUid);
            $isAppAdmin = $this->groupManager->isInGroup($creatorUid, Application::getAdminGroupId($this->config));
            if (!$isServerAdmin && !$isAppAdmin && !$this->isSupervisorOf($creatorUid, $target)) {
                return new JSONResponse(['error' => 'Vous ne pouvez pas créer une demande pour cet employé'], 403);
            }
        }
        // Validate dates: ensure format and chronological order (end >= start)
        try {
            $sd = \DateTimeImmutable::createFromFormat('Y-m-d', $startDate);
            $ed = \DateTimeImmutable::createFromFormat('Y-m-d', $endDate);
        } catch (\Throwable $e) {
            $sd = false;
            $ed = false;
        }
        if ($sd === false || $ed === false) {
            return new JSONResponse(['error' => 'Dates invalides (format attendu: YYYY-MM-DD)'], 400);
        }
        if ($ed < $sd) {
            return new JSONResponse(['error' => 'La date de fin ne peut pas être antérieure à la date de début'], 400);
        }
        $created = $this->leaveService->createLeave($target, $startDate, $endDate, $type, $reason, $dayParts);
        return new JSONResponse(['leave' => $created]);
    }

    /**
     * @NoAdminRequired
     * @NoCSRFRequired
     */
    public function deleteLeave(int $id): JSONResponse {
        $this->ensureLoggedIn();
        $user = $this->userSession->getUser();
        $ok = $this->leaveService->deleteLeave($user->getUID(), $id);
        return new JSONResponse(['success' => $ok]);
    }

    /**
     * @NoAdminRequired
     * @NoCSRFRequired
     */
    public function deleteLeaveByAdmin(int $id): JSONResponse {
        $this->ensureAppAdmin();
        $ok = $this->leaveService->deleteLeaveByAdmin($id);
        return new JSONResponse(['success' => $ok]);
    }

    /**
     * @NoAdminRequired
     * @NoCSRFRequired
     */
    public function getAllLeaves(): JSONResponse {
        $this->ensureAppAdmin();
        $user = $this->userSession->getUser();
        if ($user === null) {
            throw new \Exception('Not logged in');
        }
        // All admins of the app (and server admins) can see all leaves
        $data = $this->leaveService->getAllLeaves();
        $this->logger->debug('[talk_rh] getAllLeaves: returning all leaves for admin uid=' . $user->getUID() . ', count=' . count($data), ['app' => 'talk_rh']);
        return new JSONResponse(['leaves' => $data]);
    }

    /**
     */
    private function isSupervisorOf(string $supervisorUid, string $employeeUid): bool {
        try {
            $employee = $this->userManager->get($employeeUid);
            if ($employee === null) {
                $this->logger->debug('[talk_rh] isSupervisorOf: employee not found: ' . $employeeUid, ['app' => 'talk_rh']);
                return false;
            }
            $account = $this->accountManager->getAccount($employee);
            if ($account === null) {
                $this->logger->debug('[talk_rh] isSupervisorOf: account not found for: ' . $employeeUid, ['app' => 'talk_rh']);
                return false;
            }
            $this->logger->debug('[talk_rh] isSupervisorOf: checking supervisor for employee=' . $employeeUid, ['app' => 'talk_rh']);
            // Preferred API: dedicated manager property (primary) then supervisor (secondary)
            if (method_exists($account, 'getProperty')) {
                if (defined('OCP\\Accounts\\IAccountManager::PROPERTY_MANAGER')) {
                    $prop = $account->getProperty(IAccountManager::PROPERTY_MANAGER);
                    if ($prop && method_exists($prop, 'getValue')) {
                        $value = (string)$prop->getValue();
                        $this->logger->debug('[talk_rh] isSupervisorOf: PROPERTY_MANAGER=' . $value . ' for employee=' . $employeeUid, ['app' => 'talk_rh']);
                        $valUid = $this->resolveValueToUid($value);
                        if ($valUid === $supervisorUid) {
                            return true;
                        }
                    }
                }
                if (defined('OCP\\Accounts\\IAccountManager::PROPERTY_SUPERVISOR')) {
                    $prop = $account->getProperty(IAccountManager::PROPERTY_SUPERVISOR);
                    if ($prop && method_exists($prop, 'getValue')) {
                        $value = (string)$prop->getValue();
                        $this->logger->debug('[talk_rh] isSupervisorOf: PROPERTY_SUPERVISOR=' . $value . ' for employee=' . $employeeUid, ['app' => 'talk_rh']);
                        $valUid = $this->resolveValueToUid($value);
                        if ($valUid === $supervisorUid) {
                            return true;
                        }
                    }
                }
            }
            // Config-based fallback: read settings/manager from user config (JSON array or scalar)
            $cfgManagers = $this->getConfigManagerUids($employeeUid);
            if (!empty($cfgManagers)) {
                $this->logger->debug('[talk_rh] isSupervisorOf: config managers for employee=' . $employeeUid . ' => [' . implode(',', $cfgManagers) . ']', ['app' => 'talk_rh']);
                if (in_array($supervisorUid, $cfgManagers, true)) {
                    return true;
                }
            }
            // Fallback: scan properties for a "manager"/"supervisor" name
            if (method_exists($account, 'getProperties')) {
                $this->logger->debug('[talk_rh] isSupervisorOf: scanning properties for employee=' . $employeeUid, ['app' => 'talk_rh']);
                foreach ((array)$account->getProperties() as $p) {
                    $name = method_exists($p, 'getName') ? (string)$p->getName() : '';
                    if ($name !== '') {
                        $n = strtolower($name);
                        if ($n === 'manager' || $n === 'supervisor') {
                            $val = method_exists($p, 'getValue') ? (string)$p->getValue() : '';
                            $this->logger->debug('[talk_rh] isSupervisorOf: found property ' . $name . '=' . $val . ' for employee=' . $employeeUid, ['app' => 'talk_rh']);
                            $valUid = $this->resolveValueToUid($val);
                            if ($valUid === $supervisorUid) return true;
                        }
                    }
                }
            }
            $this->logger->debug('[talk_rh] isSupervisorOf: no supervisor match found for employee=' . $employeeUid, ['app' => 'talk_rh']);
        } catch (\Throwable $e) {
            $this->logger->error('[talk_rh] isSupervisorOf failed for supervisor=' . $supervisorUid . ', employee=' . $employeeUid . ': ' . $e->getMessage(), ['app' => 'talk_rh']);
        }
        return false;
    }

    /**
     * Try to resolve an arbitrary account reference to a UID.
     * Accepts UID directly, an email address, or a display name.
     */
    private function resolveValueToUid(string $value): string {
        $value = trim($value);
        if ($value === '') return '';
        // 1) Direct UID
        try {
            $u = $this->userManager->get($value);
            if ($u !== null) return $u->getUID();
        } catch (\Throwable $e) { /* ignore */ }
        // 2) Email -> UID
        try {
            if (method_exists($this->userManager, 'getByEmail')) {
                $byEmail = $this->userManager->getByEmail($value);
                if (is_array($byEmail) && count($byEmail) > 0) {
                    $first = $byEmail[0];
                    if ($first !== null) return $first->getUID();
                }
            }
        } catch (\Throwable $e) { /* ignore */ }
        // 3) Display name search
        try {
            if (method_exists($this->userManager, 'searchDisplayName')) {
                $found = $this->userManager->searchDisplayName($value, 10, 0);
                foreach ($found as $cand) {
                    if (strcasecmp($cand->getDisplayName(), $value) === 0) {
                        return $cand->getUID();
                    }
                }
            } else {
                // Fallback: search all and exact-match by display name
                $all = $this->userManager->search('');
                foreach ($all as $cand) {
                    if (strcasecmp($cand->getDisplayName(), $value) === 0) {
                        return $cand->getUID();
                    }
                }
            }
        } catch (\Throwable $e) { /* ignore */ }
        return '';
    }

    /**
     * Read managers from user config (app 'settings', key 'manager').
     * Value can be a JSON array of identifiers or a single identifier.
     * Returns resolved UIDs.
     */
    private function getConfigManagerUids(string $employeeUid): array {
        try {
            $raw = $this->config->getUserValue($employeeUid, 'settings', 'manager', '');
            if ($raw === '' || $raw === null) return [];
            $resolved = [];
            $decoded = null;
            try {
                $decoded = json_decode($raw, true, 512, JSON_THROW_ON_ERROR);
            } catch (\Throwable $e) {
                // Not JSON; treat as scalar value
            }
            if (is_array($decoded)) {
                foreach ($decoded as $val) {
                    if (!is_string($val)) continue;
                    $uid = $this->resolveValueToUid($val);
                    if ($uid !== '') $resolved[] = $uid;
                }
            } else {
                $uid = $this->resolveValueToUid((string)$raw);
                if ($uid !== '') $resolved[] = $uid;
            }
            return array_values(array_unique($resolved));
        } catch (\Throwable $e) {
            return [];
        }
    }

    /**
     * @NoAdminRequired
     * @NoCSRFRequired
     */
    public function setLeaveStatus(int $id, string $status, string $adminComment = ''): JSONResponse {
        $this->ensureAppAdmin();
        $ok = $this->leaveService->setLeaveStatus($id, $status, $adminComment);
        $leave = $this->leaveService->getLeaveById($id);
        $debug = (string)($this->request->getParam('debug') ?? '0');
        $withDiag = ($debug === '1' || strtolower($debug) === 'true');
        $payload = ['success' => $ok, 'leave' => $leave];
        if ($withDiag && method_exists($this->leaveService, 'getLastCalendarDiag')) {
            try { $payload['calendarDiag'] = $this->leaveService->getLastCalendarDiag(); } catch (\Throwable $e) {}
        }
        return new JSONResponse($payload);
    }

    /**
     * @NoAdminRequired
     * @NoCSRFRequired
     */
    public function saveAdminGroup(string $groupId): JSONResponse {
        $this->ensureAppAdmin();
        $this->config->setAppValue(Application::APP_ID, 'admin_group', $groupId);
        return new JSONResponse(['saved' => true, 'groupId' => $groupId]);
    }

    /**
     * @NoAdminRequired
     * @NoCSRFRequired
     */
    public function getAdminGroup(): JSONResponse {
        try {
            $this->ensureAppAdmin();
            $gid = Application::getAdminGroupId($this->config);
            $this->logger->debug('[talk_rh] getAdminGroup: returning groupId=' . $gid, ['app' => 'talk_rh']);
            return new JSONResponse(['groupId' => $gid]);
        } catch (\Throwable $e) {
            $this->logger->error('[talk_rh] getAdminGroup failed: ' . $e->getMessage(), ['app' => 'talk_rh']);
            return new JSONResponse(['error' => $e->getMessage()], 500);
        }
    }

    /**
     * @NoAdminRequired
     * @NoCSRFRequired
     */
    public function listGroups(): JSONResponse {
        $this->ensureAppAdmin();
        // Search all groups (empty search) with a generous limit
        if (method_exists($this->groupManager, 'search')) {
            $groups = $this->groupManager->search('', 500, 0);
        } else {
            $groups = [];
        }
        $res = [];
        foreach ($groups as $g) {
            $res[] = [
                'id' => $g->getGID(),
                'displayName' => method_exists($g, 'getDisplayName') ? $g->getDisplayName() : $g->getGID(),
            ];
        }
        return new JSONResponse(['groups' => $res]);
    }

    /**
     * @NoAdminRequired
     * @NoCSRFRequired
     */
    public function getTalkSetting(): JSONResponse {
        $this->ensureAppAdmin();
        $enabled = $this->config->getAppValue(Application::APP_ID, 'talk_enabled', '0') === '1';
        return new JSONResponse(['talkEnabled' => $enabled]);
    }

    /**
     * @NoAdminRequired
     * @NoCSRFRequired
     */
    public function saveTalkSetting(string $enabled): JSONResponse {
        $this->ensureAppAdmin();
        $val = ($enabled === '1' || strtolower($enabled) === 'true') ? '1' : '0';
        $this->config->setAppValue(Application::APP_ID, 'talk_enabled', $val);
        return new JSONResponse(['saved' => true, 'talkEnabled' => $val === '1']);
    }

    /**
     * List multi-user Talk channels available to the current admin user.
     * @NoAdminRequired
     * @NoCSRFRequired
     */
    public function listTalkChannels(): JSONResponse {
        $this->ensureAppAdmin();
        $channels = $this->leaveService->getTalkChannels();
        return new JSONResponse(['channels' => $channels]);
    }

    /**
     * Get currently selected broadcast channel token (if any).
     * @NoAdminRequired
     * @NoCSRFRequired
     */
    public function getTalkChannel(): JSONResponse {
        $this->ensureAppAdmin();
        $token = $this->leaveService->getSelectedTalkChannelToken();
        return new JSONResponse(['token' => $token]);
    }

    /**
     * Save selected broadcast channel token (empty to disable broadcast).
     * @NoAdminRequired
     * @NoCSRFRequired
     */
    public function saveTalkChannel(string $token = ''): JSONResponse {
        $this->ensureAppAdmin();
        $this->leaveService->saveSelectedTalkChannelToken($token);
        return new JSONResponse(['saved' => true, 'token' => $token]);
    }

    /**
     * Admin diagnostic endpoint to test Talk DM sending.
     * Params (POST): fromUid (optional), toUid (required), message (optional)
     * @NoAdminRequired
     * @NoCSRFRequired
     */
    public function testTalk(): JSONResponse {
        try {
            $this->ensureAppAdmin();
            $fromUid = (string)($this->request->getParam('fromUid') ?? '');
            $toUid = (string)($this->request->getParam('toUid') ?? '');
            $message = (string)($this->request->getParam('message') ?? 'Message de test Talk');
            if ($toUid === '') {
                return new JSONResponse(['error' => 'Paramètre toUid manquant'], 400);
            }
            $diag = $this->leaveService->testTalkDM($fromUid, $toUid, $message);
            return new JSONResponse(['diag' => $diag]);
        } catch (\Throwable $e) {
            return new JSONResponse(['error' => $e->getMessage()], 500);
        }
    }

    /**
     * @NoAdminRequired
     * @NoCSRFRequired
     */
    public function getAdminGroupMembers(): JSONResponse {
        $this->ensureAppAdmin();
        $gid = (string)$this->request->getParam('groupId') ?: Application::getAdminGroupId($this->config);
        $group = $this->groupManager->get($gid);
        if ($group === null) {
            return new JSONResponse(['groupId' => $gid, 'members' => []]);
        }
        $members = [];
        foreach ($group->getUsers() as $user) {
            $members[] = [
                'uid' => $user->getUID(),
                'displayName' => $user->getDisplayName(),
            ];
        }
        return new JSONResponse(['groupId' => $gid, 'members' => $members]);
    }
}
